use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::{IpcError, MAX_MESSAGE_BYTES, RemoteError, Request, Response};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// `\\.\pipe\<name>`
    #[cfg(windows)]
    Pipe(String),
    #[cfg(unix)]
    Socket(std::path::PathBuf),
}

impl Endpoint {
    #[cfg(windows)]
    pub fn default_for(_data_dir: &std::path::Path) -> Self {
        Endpoint::Pipe(r"\\.\pipe\ghost-agent".into())
    }

    #[cfg(unix)]
    pub fn default_for(data_dir: &std::path::Path) -> Self {
        Endpoint::Socket(data_dir.join("agent.sock"))
    }
}

/// Reads one line, bounded. Returns `Ok(None)` on clean EOF.
pub async fn read_line<R: AsyncRead + Unpin>(r: &mut BufReader<R>) -> Result<Option<String>, IpcError> {
    let mut buf = Vec::new();
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            return if buf.is_empty() { Ok(None) } else { Err(IpcError::Protocol("unexpected EOF".into())) };
        }
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        if buf.len() + take > MAX_MESSAGE_BYTES {
            return Err(IpcError::Protocol("message too large".into()));
        }
        buf.extend_from_slice(&chunk[..take]);
        r.consume(take);
        if done {
            buf.pop();
            return String::from_utf8(buf).map(Some).map_err(|_| IpcError::Protocol("invalid UTF-8".into()));
        }
    }
}

pub async fn write_json<W: AsyncWrite + Unpin, T: serde::Serialize>(w: &mut W, v: &T) -> Result<(), IpcError> {
    let mut bytes = serde_json::to_vec(v).map_err(|e| IpcError::Protocol(e.to_string()))?;
    if bytes.len() >= MAX_MESSAGE_BYTES {
        return Err(IpcError::Protocol("message too large".into()));
    }
    bytes.push(b'\n');
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

/// Serves one connection until EOF or a protocol error.
pub async fn serve<S, F, Fut>(stream: S, handler: F) -> Result<(), IpcError>
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(String, Value) -> Fut,
    Fut: std::future::Future<Output = Result<Value, RemoteError>>,
{
    let (r, mut w) = tokio::io::split(stream);
    let mut r = BufReader::new(r);
    while let Some(line) = read_line(&mut r).await? {
        let res = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match handler(req.method, req.params).await {
                Ok(v) => Response { id: req.id, result: Some(v), error: None },
                Err(e) => Response { id: req.id, result: None, error: Some(e) },
            },
            Err(e) => Response { id: 0, result: None, error: Some(RemoteError::bad_request(e.to_string())) },
        };
        write_json(&mut w, &res).await?;
    }
    Ok(())
}

// ---- client -------------------------------------------------------------------

#[cfg(windows)]
type ClientStream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
type ClientStream = tokio::net::UnixStream;

pub struct IpcClient {
    reader: BufReader<tokio::io::ReadHalf<ClientStream>>,
    writer: tokio::io::WriteHalf<ClientStream>,
    next_id: u64,
    timeout: Duration,
}

impl IpcClient {
    pub async fn connect(ep: &Endpoint) -> Result<Self, IpcError> {
        let stream = match ep {
            #[cfg(windows)]
            Endpoint::Pipe(name) => open_pipe(name).await?,
            #[cfg(unix)]
            Endpoint::Socket(path) => tokio::net::UnixStream::connect(path).await.map_err(IpcError::Connect)?,
        };
        let (r, w) = tokio::io::split(stream);
        Ok(Self { reader: BufReader::new(r), writer: w, next_id: 1, timeout: Duration::from_secs(5) })
    }

    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, IpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let req = Request { id, method: method.into(), params };
        let fut = async {
            write_json(&mut self.writer, &req).await?;
            let line = read_line(&mut self.reader).await?.ok_or_else(|| IpcError::Protocol("agent closed".into()))?;
            let res: Response = serde_json::from_str(&line).map_err(|e| IpcError::Protocol(e.to_string()))?;
            if res.id != id {
                return Err(IpcError::Protocol(format!("response id {} != {id}", res.id)));
            }
            match (res.result, res.error) {
                (_, Some(e)) => Err(IpcError::Remote(e)),
                (Some(v), None) => Ok(v),
                (None, None) => Ok(Value::Null),
            }
        };
        tokio::time::timeout(self.timeout, fut).await.map_err(|_| IpcError::Timeout)?
    }
}

/// All pipe instances can be momentarily busy between the server accepting one
/// client and creating the next instance; Windows clients are expected to retry.
#[cfg(windows)]
async fn open_pipe(name: &str) -> Result<ClientStream, IpcError> {
    use tokio::net::windows::named_pipe::ClientOptions;
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        match ClientOptions::new().open(name) {
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            other => return other.map_err(IpcError::Connect),
        }
    }
}

/// True when running under Wine (used to skip checks Wine does not implement).
#[cfg(windows)]
pub fn running_under_wine() -> bool {
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows::core::{s, w};
    unsafe {
        GetModuleHandleW(w!("ntdll.dll")).ok().is_some_and(|h| GetProcAddress(h, s!("wine_get_version")).is_some())
    }
}

// ---- listener -----------------------------------------------------------------

pub struct Listener {
    #[cfg(windows)]
    name: String,
    /// The instance the next client will connect to (None: create it on the next accept).
    #[cfg(windows)]
    next: Option<tokio::net::windows::named_pipe::NamedPipeServer>,
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
}

#[cfg(windows)]
pub type ServerStream = tokio::net::windows::named_pipe::NamedPipeServer;
#[cfg(unix)]
pub type ServerStream = tokio::net::UnixStream;

impl Listener {
    pub fn bind(ep: &Endpoint) -> std::io::Result<Self> {
        match ep {
            #[cfg(windows)]
            Endpoint::Pipe(name) => Ok(Self { name: name.clone(), next: Some(windows_pipe::create(name, true)?) }),
            #[cfg(unix)]
            Endpoint::Socket(path) => {
                use std::os::unix::fs::PermissionsExt;
                if let Some(dir) = path.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                // A stale socket from a crashed agent blocks bind.
                if std::os::unix::net::UnixStream::connect(path).is_err() {
                    let _ = std::fs::remove_file(path);
                }
                let inner = tokio::net::UnixListener::bind(path)?;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
                Ok(Self { inner })
            }
        }
    }

    pub async fn accept(&mut self) -> std::io::Result<ServerStream> {
        #[cfg(windows)]
        {
            let server = match self.next.take() {
                Some(s) => s,
                None => windows_pipe::create(&self.name, false)?,
            };
            server.connect().await?;
            // Serve this client even if the next instance cannot be created now; the next
            // accept retries (and reports) the creation.
            self.next = windows_pipe::create(&self.name, false).ok();
            Ok(server)
        }
        #[cfg(unix)]
        {
            Ok(self.inner.accept().await?.0)
        }
    }
}

#[cfg(windows)]
mod windows_pipe {
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::core::w;

    /// SYSTEM, Administrators and the pipe's owner (the agent's own account, e.g. the
    /// service's virtual account, which needs it to create the next instances): full;
    /// interactive users (IU): read/write.
    /// Network logons are excluded by the DACL and by rejecting remote clients.
    const SDDL: windows::core::PCWSTR = w!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)(A;;GRGW;;;IU)");

    pub fn create(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(SDDL, SDDL_REVISION_1, &mut sd, None)
                .map_err(std::io::Error::other)?;
        }
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        let res = unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .max_instances(8)
                .create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut std::ffi::c_void)
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
        res
    }
}
