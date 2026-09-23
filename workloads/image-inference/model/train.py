"""Trains the built-in digit classifier (MLP 64-128-10) on scikit-learn's bundled
`digits` dataset and exports weights for the WebAssembly workload.

This is offline model preparation (one machine, ~seconds), not distributed training.
Deterministic: fixed seeds, fixed split.

Output: digits-mlp.bin (little-endian f32) + metadata.json + testdata/.
"""
import hashlib, json, struct
from pathlib import Path

import numpy as np
from PIL import Image
from sklearn.datasets import load_digits
from sklearn.model_selection import train_test_split

HERE = Path(__file__).parent
rng = np.random.default_rng(0)

d = load_digits()
X = d.data.astype(np.float32) / 16.0  # 8x8, ink bright, 0..16 → 0..1
y = d.target
Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0, stratify=y)

H = 128
W1 = (rng.standard_normal((64, H)) * np.sqrt(2 / 64)).astype(np.float32)
b1 = np.zeros(H, np.float32)
W2 = (rng.standard_normal((H, 10)) * np.sqrt(2 / H)).astype(np.float32)
b2 = np.zeros(10, np.float32)
params = [W1, b1, W2, b2]
m = [np.zeros_like(p) for p in params]
v = [np.zeros_like(p) for p in params]

def forward(x):
    h = np.maximum(0, x @ W1 + b1)
    z = h @ W2 + b2
    z = z - z.max(axis=1, keepdims=True)
    p = np.exp(z); p /= p.sum(axis=1, keepdims=True)
    return h, p

lr, b1m, b2m, t = 1e-3, 0.9, 0.999, 0
for epoch in range(80):
    idx = rng.permutation(len(Xtr))
    for s in range(0, len(idx), 32):
        bi = idx[s:s + 32]
        x, yy = Xtr[bi], ytr[bi]
        h, p = forward(x)
        g = p.copy(); g[np.arange(len(yy)), yy] -= 1; g /= len(yy)
        gW2 = h.T @ g; gb2 = g.sum(0)
        gh = g @ W2.T; gh[h <= 0] = 0
        gW1 = x.T @ gh; gb1 = gh.sum(0)
        t += 1
        for i, gr in enumerate([gW1, gb1, gW2, gb2]):
            m[i] = b1m * m[i] + (1 - b1m) * gr
            v[i] = b2m * v[i] + (1 - b2m) * gr * gr
            mh = m[i] / (1 - b1m ** t); vh = v[i] / (1 - b2m ** t)
            params[i] -= lr * mh / (np.sqrt(vh) + 1e-8)

acc = float((forward(Xte)[1].argmax(1) == yte).mean())
print(f"test accuracy: {acc:.4f} on {len(yte)} held-out images")

blob = b"GHMLP1\0\0" + struct.pack("<III", 64, H, 10)
for p in params:
    blob += p.astype("<f4").tobytes()
(HERE / "digits-mlp.bin").write_bytes(blob)
meta = {
    "name": "digits-mlp",
    "version": "1.0.0",
    "architecture": "MLP 64-128(ReLU)-10(softmax)",
    "input": "8x8 grayscale, ink bright, scaled 0..1",
    "labels": [str(i) for i in range(10)],
    "dataset": "scikit-learn digits (1797 images), 80/20 stratified split, random_state=0",
    "testAccuracy": round(acc, 4),
    "sha256": hashlib.sha256(blob).hexdigest(),
}
(HERE / "metadata.json").write_text(json.dumps(meta, indent=2) + "\n")

# Held-out set for the Rust accuracy test: 8x8 bytes (0..16) + label.
td = HERE.parent / "testdata"
td.mkdir(exist_ok=True)
raw = bytearray()
for x, label in zip((Xte * 16).round().astype(np.uint8), yte):
    raw += bytes(x) + bytes([label])
(td / "digits-test.bin").write_bytes(bytes(raw))

# Realistic inputs: dark ink on white paper, upscaled, as PNG and JPEG.
for i in range(12):
    img = (255 - (Xte[i] * 255)).reshape(8, 8).astype(np.uint8)
    big = Image.fromarray(img, "L").resize((64, 64), Image.NEAREST)
    big.save(td / f"digit-{i:02d}-label{yte[i]}.png")
    big.convert("RGB").save(td / f"digit-{i:02d}-label{yte[i]}.jpg", quality=95)
print(json.dumps(meta, indent=2))
