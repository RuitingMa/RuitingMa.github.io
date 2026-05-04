"""
Train the tiny MLP used by /sketches/shi/ — numpy edition.

Architecture:
    784 → 16 (ReLU) → 16 (ReLU) → 10

Deliberately small and deliberately not convolutional — the page shows
off MLP's spatial fragility (draw off-center and it gets confused).

Exports:
    public/models/shi/weights.bin    flat float32 binary of all learned params
    public/models/shi/manifest.json  per-tensor {shape, offset, length}

The browser reads both, views the binary as named Float32Arrays, and runs
a hand-written forward pass (no ML runtime shipped). See ShiSketch.astro.

Run:
    python scripts/train-shi.py

No torch needed — pure numpy + Adam from scratch, <1 min on CPU.
Uses MNIST raw IDX files that torchvision (or this script) downloaded
into data/MNIST/raw/.
"""

import gzip
import json
import os
import struct
import urllib.request

import numpy as np

OUT_DIR = os.path.join("public", "models", "shi")
DATA_DIR = os.path.join("data", "MNIST", "raw")

H1 = 16
H2 = 16
EPOCHS = 40
BATCH = 128
LR = 1e-3

MNIST_URLS = {
    "train-images-idx3-ubyte": "https://storage.googleapis.com/cvdf-datasets/mnist/train-images-idx3-ubyte.gz",
    "train-labels-idx1-ubyte": "https://storage.googleapis.com/cvdf-datasets/mnist/train-labels-idx1-ubyte.gz",
    "t10k-images-idx3-ubyte":  "https://storage.googleapis.com/cvdf-datasets/mnist/t10k-images-idx3-ubyte.gz",
    "t10k-labels-idx1-ubyte":  "https://storage.googleapis.com/cvdf-datasets/mnist/t10k-labels-idx1-ubyte.gz",
}


def _ensure(path_raw: str) -> str:
    """Return a readable IDX file path, downloading + ungzipping if needed."""
    if os.path.exists(path_raw):
        return path_raw
    os.makedirs(os.path.dirname(path_raw), exist_ok=True)
    name = os.path.basename(path_raw)
    gz_path = path_raw + ".gz"
    if not os.path.exists(gz_path):
        url = MNIST_URLS[name]
        print(f"downloading {url}")
        urllib.request.urlretrieve(url, gz_path)
    with gzip.open(gz_path, "rb") as src, open(path_raw, "wb") as dst:
        dst.write(src.read())
    return path_raw


def load_images(name: str) -> np.ndarray:
    path = _ensure(os.path.join(DATA_DIR, name))
    with open(path, "rb") as f:
        magic, n, rows, cols = struct.unpack(">IIII", f.read(16))
        assert magic == 2051
        buf = f.read(n * rows * cols)
    return np.frombuffer(buf, dtype=np.uint8).reshape(n, rows * cols).astype(np.float32) / 255.0


def load_labels(name: str) -> np.ndarray:
    path = _ensure(os.path.join(DATA_DIR, name))
    with open(path, "rb") as f:
        magic, n = struct.unpack(">II", f.read(8))
        assert magic == 2049
        buf = f.read(n)
    return np.frombuffer(buf, dtype=np.uint8).astype(np.int64)


def softmax_ce_grad(logits: np.ndarray, y: np.ndarray):
    """Return (loss_mean, dlogits) for softmax + cross-entropy."""
    m = logits.max(axis=1, keepdims=True)
    e = np.exp(logits - m)
    probs = e / e.sum(axis=1, keepdims=True)
    n = logits.shape[0]
    loss = -np.log(np.clip(probs[np.arange(n), y], 1e-12, 1.0)).mean()
    dlogits = probs.copy()
    dlogits[np.arange(n), y] -= 1.0
    dlogits /= n
    return loss, dlogits


class Adam:
    def __init__(self, params, lr=1e-3, b1=0.9, b2=0.999, eps=1e-8):
        self.p = params
        self.lr, self.b1, self.b2, self.eps = lr, b1, b2, eps
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def step(self, grads):
        self.t += 1
        for k, g in grads.items():
            self.m[k] = self.b1 * self.m[k] + (1 - self.b1) * g
            self.v[k] = self.b2 * self.v[k] + (1 - self.b2) * (g * g)
            mh = self.m[k] / (1 - self.b1 ** self.t)
            vh = self.v[k] / (1 - self.b2 ** self.t)
            self.p[k] -= self.lr * mh / (np.sqrt(vh) + self.eps)


def init_params() -> dict:
    rng = np.random.default_rng(0)
    # He init for ReLU layers; smaller for the final linear.
    p = {
        "fc1.weight": rng.standard_normal((H1, 784)).astype(np.float32) * np.sqrt(2.0 / 784),
        "fc1.bias":   np.zeros(H1, dtype=np.float32),
        "fc2.weight": rng.standard_normal((H2, H1)).astype(np.float32) * np.sqrt(2.0 / H1),
        "fc2.bias":   np.zeros(H2, dtype=np.float32),
        "out.weight": rng.standard_normal((10, H2)).astype(np.float32) * np.sqrt(1.0 / H2),
        "out.bias":   np.zeros(10, dtype=np.float32),
    }
    return p


def forward(p, x):
    """x: (N, 784). Returns (logits, cache)."""
    z1 = x @ p["fc1.weight"].T + p["fc1.bias"]
    a1 = np.maximum(0, z1)
    z2 = a1 @ p["fc2.weight"].T + p["fc2.bias"]
    a2 = np.maximum(0, z2)
    logits = a2 @ p["out.weight"].T + p["out.bias"]
    return logits, (x, z1, a1, z2, a2)


def backward(p, cache, dlogits):
    x, z1, a1, z2, a2 = cache
    g = {}
    g["out.weight"] = dlogits.T @ a2
    g["out.bias"]   = dlogits.sum(axis=0)
    da2 = dlogits @ p["out.weight"]
    dz2 = da2 * (z2 > 0)
    g["fc2.weight"] = dz2.T @ a1
    g["fc2.bias"]   = dz2.sum(axis=0)
    da1 = dz2 @ p["fc2.weight"]
    dz1 = da1 * (z1 > 0)
    g["fc1.weight"] = dz1.T @ x
    g["fc1.bias"]   = dz1.sum(axis=0)
    return g


def accuracy(p, x, y) -> float:
    logits, _ = forward(p, x)
    return float((logits.argmax(axis=1) == y).mean())


def train():
    print("loading MNIST…")
    x_tr = load_images("train-images-idx3-ubyte")
    y_tr = load_labels("train-labels-idx1-ubyte")
    x_te = load_images("t10k-images-idx3-ubyte")
    y_te = load_labels("t10k-labels-idx1-ubyte")
    print(f"train {x_tr.shape}  test {x_te.shape}")

    p = init_params()
    opt = Adam(p, lr=LR)
    rng = np.random.default_rng(1)

    n = x_tr.shape[0]
    for epoch in range(1, EPOCHS + 1):
        order = rng.permutation(n)
        loss_sum, count = 0.0, 0
        for i in range(0, n, BATCH):
            idx = order[i : i + BATCH]
            xb, yb = x_tr[idx], y_tr[idx]
            logits, cache = forward(p, xb)
            loss, dlogits = softmax_ce_grad(logits, yb)
            grads = backward(p, cache, dlogits)
            opt.step(grads)
            loss_sum += loss * xb.shape[0]
            count += xb.shape[0]
        acc = accuracy(p, x_te, y_te)
        print(f"epoch {epoch:2d}  loss {loss_sum / count:.4f}  test_acc {acc:.4f}")

    return p


def export(p: dict) -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    # Order here == byte order in weights.bin. JS keys by name, so layout
    # is arbitrary — but layer-sequential makes the bin readable via hexdump.
    order = [
        ("fc1.weight", p["fc1.weight"]),
        ("fc1.bias",   p["fc1.bias"]),
        ("fc2.weight", p["fc2.weight"]),
        ("fc2.bias",   p["fc2.bias"]),
        ("out.weight", p["out.weight"]),
        ("out.bias",   p["out.bias"]),
    ]

    manifest = {"tensors": {}}
    offset = 0
    with open(os.path.join(OUT_DIR, "weights.bin"), "wb") as f:
        for name, t in order:
            flat = np.ascontiguousarray(t, dtype=np.float32).reshape(-1)
            f.write(flat.tobytes())
            manifest["tensors"][name] = {
                "shape": list(t.shape),
                "offset": offset,
                "length": int(flat.size),
            }
            offset += flat.size * 4

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    print(f"wrote {OUT_DIR}/weights.bin  ({offset} bytes)")
    print(f"wrote {OUT_DIR}/manifest.json")


if __name__ == "__main__":
    export(train())
