"""
摸鱼 / 认真 图像分类器 —— 可直接嵌入项目的最小实现。

命令行：python infer.py 图片.jpg
代码：  from infer import SlackClassifier
        clf = SlackClassifier("best.onnx")
        clf.predict("图片.jpg")   ->  {'label': '摸鱼', 'index': 0, 'score': 0.98, ...}

依赖：pip install onnxruntime numpy pillow
（若运行环境里 onnxruntime 不可用，会自动回退到 onnx 参考实现，仅建议调试用）
"""
from __future__ import annotations

import os
import subprocess
import sys

import numpy as np
from PIL import Image

CLASSES = ["摸鱼", "认真"]
INPUT_SIZE = 256  # 默认值；实际会从 onnx 输入形状自动读取（本包内置 256 主模型 / 224 兼容模型）
DEFAULT_MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "best.onnx")


def preprocess(img, size: int = INPUT_SIZE) -> np.ndarray:
    """与训练一致：短边缩放到 size，中心裁剪 size×size，/255，HWC→CHW，加 batch 维。"""
    if isinstance(img, (str, os.PathLike)):
        img = Image.open(img)
    img = img.convert("RGB")
    w, h = img.size
    if min(w, h) != size:
        s = size / min(w, h)
        img = img.resize((max(size, int(round(w * s))), max(size, int(round(h * s)))), Image.BILINEAR)
    w, h = img.size
    left, top = (w - size) // 2, (h - size) // 2
    img = img.crop((left, top, left + size, top + size))
    x = np.asarray(img, dtype=np.float32) / 255.0
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def _ort_usable() -> bool:
    """在子进程里试导入 onnxruntime —— 某些环境的 DLL 冲突会让进程直接崩溃，异常捕获不到。"""
    if os.environ.get("FORCE_ONNX_REF") == "1":
        return False
    if not sys.executable:
        return True
    try:
        r = subprocess.run([sys.executable, "-c", "import onnxruntime"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        return r.returncode == 0
    except Exception:
        return False


class SlackClassifier:
    def __init__(self, model_path: str = DEFAULT_MODEL, providers=None):
        self.model_path = model_path
        self._providers = providers
        self._sess = None
        self._input = None
        self.size = INPUT_SIZE
        self.backend = None

    def _session(self):
        if self._sess is not None:
            return self._sess
        if _ort_usable():
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            self._sess = ort.InferenceSession(self.model_path, opts,
                                              providers=self._providers or ["CPUExecutionProvider"])
            inp = self._sess.get_inputs()[0]
            self._input = inp.name
            self.backend = "onnxruntime"
        else:
            import onnx
            from onnx.reference import ReferenceEvaluator

            m = onnx.load(self.model_path)
            self._sess = ReferenceEvaluator(m)
            inp = m.graph.input[0]
            self._input = inp.name
            self.backend = "onnx.reference"
            print("[warn] 使用 onnx 参考实现推理（慢），正式部署建议装好 onnxruntime", file=sys.stderr)
        try:  # 从 [1,3,H,W] 推断输入边长，兼容 224 / 256 两种导出
            dims = [d.dim_value if d.dim_value else None for d in inp.type.tensor_type.shape.dim]
            if len(dims) == 4 and dims[2]:
                self.size = int(dims[2])
        except Exception:
            pass
        return self._sess

    def predict_proba(self, img) -> np.ndarray:
        sess = self._session()
        out = sess.run(None, {self._input: preprocess(img, self.size)})[0]
        v = np.asarray(out, dtype=np.float32).reshape(-1)
        if v.min() < 0 or v.sum() > 1.5:  # 模型输出是 logits 时补 softmax
            e = np.exp(v - v.max())
            v = e / e.sum()
        return v

    def predict(self, img) -> dict:
        p = self.predict_proba(img)
        i = int(np.argmax(p))
        return {"label": CLASSES[i], "index": i, "score": float(p[i]),
                "scores": {CLASSES[j]: float(p[j]) for j in range(len(CLASSES))}}

    def predict_batch(self, imgs):
        return [self.predict(im) for im in imgs]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(0)
    clf = SlackClassifier()
    for path in sys.argv[1:]:
        clf._session()
        r = clf.predict(path)
        print(f"{os.path.basename(path)}\t{r['label']}\t{r['score']:.4f}\tbackend={clf.backend}")
