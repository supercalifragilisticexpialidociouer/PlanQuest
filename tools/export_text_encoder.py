# -*- coding: utf-8 -*-
"""导出 gte-small-zh 句向量编码器为 ONNX（CLS 池化 + L2 归一化内置），并做 int8 量化校验。

输出（写到 planquest/src/renderer/vendor/pq-text/）：
  encoder.onnx        动态 int8 量化后的 BERT 编码器，输出已归一化的 512 维向量
  vocab.txt           WordPiece 词表（JS 分词器用）
  head.json           分类头权重（512x512 -> 512 -> 2，转置为行优先 [out][in]）
用法：python tools/export_text_encoder.py
"""
import json
import os
import sys

import numpy as np
import torch
import torch.nn as nn
from transformers import AutoModel, AutoTokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "src", "renderer", "vendor", "pq-text")
MODEL_DIR = r"C:\Users\18824\.cache\huggingface\hub\models--thenlper--gte-small-zh\snapshots"
HEAD_BIN = r"C:\Users\18824\WorkBuddy\2026-11-09-17-27-42\classifier_t0.25\weights.bin"
SAMPLE_TXT = r"C:\Users\18824\WorkBuddy\2026-11-09-17-27-42\real_data\lccc_sample_500.txt"
os.makedirs(OUT, exist_ok=True)


def snapshot_dir():
    sub = [d for d in os.listdir(MODEL_DIR) if os.path.isdir(os.path.join(MODEL_DIR, d))]
    assert sub, "找不到 gte-small-zh 快照"
    return os.path.join(MODEL_DIR, sub[0])


class Encoder(nn.Module):
    def __init__(self, bert):
        super().__init__()
        self.bert = bert

    def forward(self, input_ids, attention_mask, token_type_ids):
        out = self.bert(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids)
        cls = out.last_hidden_state[:, 0]  # CLS 池化（与 SentenceTransformer 配置一致）
        return torch.nn.functional.normalize(cls, p=2, dim=1)


def main():
    snap = snapshot_dir()
    tok = AutoTokenizer.from_pretrained(snap)
    bert = AutoModel.from_pretrained(snap, torch_dtype=torch.float32).eval()
    enc = Encoder(bert).eval()

    # ---- 参考输出（HF 原模型，用于校验导出一致性）----
    sents = ["今晚加班到十点，方案还要再改一版", "哈哈哈哈这个视频笑死我了", "帮我看看这个报错怎么解决"]
    ref = []
    with torch.no_grad():
        for s in sents:
            b = tok(s, return_tensors="pt", truncation=True, max_length=256)
            ref.append(enc(b["input_ids"], b["attention_mask"], b["token_type_ids"]).numpy()[0])

    build = os.path.join(ROOT, "tools", "build")
    os.makedirs(build, exist_ok=True)
    fp32_path = os.path.join(build, "encoder_fp32.onnx")
    dummy = tok(["测试句子"], return_tensors="pt", truncation=True, max_length=256)
    torch.onnx.export(
        enc,
        (dummy["input_ids"], dummy["attention_mask"], dummy["token_type_ids"]),
        fp32_path,
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["embedding"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "token_type_ids": {0: "batch", 1: "seq"},
            "embedding": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print("fp32 onnx:", os.path.getsize(fp32_path) / 1e6, "MB")

    import onnxruntime as ort

    def embed(session, texts):
        b = tok(texts, return_tensors="np", truncation=True, max_length=256, padding=True)
        return session.run(None, {
            "input_ids": b["input_ids"].astype(np.int64),
            "attention_mask": b["attention_mask"].astype(np.int64),
            "token_type_ids": b["token_type_ids"].astype(np.int64),
        })[0]

    s32 = ort.InferenceSession(fp32_path, providers=["CPUExecutionProvider"])
    e32 = embed(s32, sents)
    cos32 = [float(np.dot(a, b)) for a, b in zip(ref, e32)]
    print("fp32 与 HF 余弦相似:", ["%.6f" % c for c in cos32])

    # ---- int8 动态量化 ----
    from onnxruntime.quantization import QuantType, quantize_dynamic

    q8_path = os.path.join(OUT, "encoder.onnx")
    quantize_dynamic(fp32_path, q8_path, weight_type=QuantType.QUInt8)
    print("int8 onnx:", os.path.getsize(q8_path) / 1e6, "MB")
    s8 = ort.InferenceSession(q8_path, providers=["CPUExecutionProvider"])
    e8 = embed(s8, sents)
    cos8 = [float(np.dot(a, b)) for a, b in zip(e32, e8)]
    print("int8 与 fp32 余弦相似:", ["%.6f" % c for c in cos8])

    # ---- 分类头：weights.bin -> head.json ----
    raw = np.fromfile(HEAD_BIN, dtype="<f4")
    i = 0

    def take(shape):
        nonlocal i
        n = int(np.prod(shape))
        a = raw[i:i + n].reshape(shape)
        i += n
        return a

    k1, b1, k2, b2 = take((512, 512)), take((512,)), take((512, 2)), take((2,))
    head = {
        "labels": ["工作", "摸鱼"],
        "dim": 512,
        "hidden": 512,
        # TFJS Dense kernel 是 [in, out]，这里转成 [out][in] 方便 JS 逐行点乘
        "w1": k1.T.reshape(-1).tolist(),
        "b1": b1.tolist(),
        "w2": k2.T.reshape(-1).tolist(),
        "b2": b2.tolist(),
    }
    with open(os.path.join(OUT, "head.json"), "w", encoding="utf-8") as f:
        json.dump(head, f, separators=(",", ":"))

    # ---- 词表 ----
    vocab = tok.get_vocab()
    with open(os.path.join(OUT, "vocab.txt"), "w", encoding="utf-8", newline="\n") as f:
        for k in sorted(vocab, key=lambda x: vocab[x]):
            f.write(k + "\n")

    # ---- 端到端一致率：int8 vs fp32 在真实闲聊 500 句上的判定 ----
    def classify(embs):
        x = embs.astype(np.float32)
        h = np.maximum(x @ k1 + b1, 0)
        logits = h @ k2 + b2
        logits -= logits.max(1, keepdims=True)
        p = np.exp(logits)
        p /= p.sum(1, keepdims=True)
        return p

    if os.path.exists(SAMPLE_TXT):
        texts = [x for x in open(SAMPLE_TXT, encoding="utf-8").read().split("\n") if x][:500]
        p32, p8 = [], []
        for s in range(0, len(texts), 50):
            chunk = texts[s:s + 50]
            p32.append(classify(embed(s32, chunk)))
            p8.append(classify(embed(s8, chunk)))
        p32, p8 = np.vstack(p32), np.vstack(p8)
        same = float((p32.argmax(1) == p8.argmax(1)).mean())
        print("真实闲聊500句 判定一致率 int8 vs fp32: %.2f%%" % (100 * same))
        print("  摸鱼占比 fp32 %.1f%% / int8 %.1f%%" % (100 * (p32.argmax(1) == 1).mean(), 100 * (p8.argmax(1) == 1).mean()))

    # 词汇量抽查
    print("vocab:", len(vocab), "文件:", sorted(os.listdir(OUT)))


if __name__ == "__main__":
    sys.exit(main())
