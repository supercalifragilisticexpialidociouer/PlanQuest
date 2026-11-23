# -*- coding: utf-8 -*-
"""生成分词/判定参考结果，供 Electron 测试脚本比对 JS 实现。

输出 dev-tests/text-ref.json：{samples:[{text, ids, pFish, label}]}
"""
import json
import os

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = r"C:\Users\18824\.cache\huggingface\hub\models--thenlper--gte-small-zh\snapshots"
SNAP = os.path.join(SNAP, [d for d in os.listdir(SNAP) if os.path.isdir(os.path.join(SNAP, d))][0])
WEIGHTS = os.path.join(ROOT, "src", "renderer", "vendor", "pq-text", "weights.bin")
SAMPLE = r"C:\Users\18824\WorkBuddy\2026-11-09-17-27-42\real_data\lccc_sample_500.txt"

EXTRA = [
    "今晚加班到十点，方案还得再改一版",
    "哈哈哈哈这个视频笑死我了，太好笑了",
    "帮我看下这个报错怎么解决，日志在附件里",
    "车间设备的保养记录我整理好了，明天发你",
    "兄弟们上号，今晚通宵",
    "在吗？在吗？人呢",
    "客户那边催得急，今天必须把图出完",
    "我摸鱼被老板抓到了呜呜呜",
    "今天的数学作业第 3 题不会做",
    "困死了，先睡一会儿再说",
    "Hello world, 这个 API 返回 500",
    "😄😄😄",
    "。。。",
    "会议纪要：下周一交付，负责人王工",
]


def load_head():
    raw = np.fromfile(WEIGHTS, dtype="<f4")
    D = 512
    i = 0

    def take(n):
        nonlocal i
        a = raw[i:i + n]
        i += n
        return a

    k1 = take(D * D).reshape(D, D)
    b1 = take(D)
    k2 = take(D * 2).reshape(D, 2)
    b2 = take(2)
    return k1, b1, k2, b2


def main():
    tok = AutoTokenizer.from_pretrained(SNAP)
    bert = AutoModel.from_pretrained(SNAP, dtype=torch.float32).eval()
    k1, b1, k2, b2 = load_head()

    texts = list(EXTRA)
    if os.path.exists(SAMPLE):
        chats = [x for x in open(SAMPLE, encoding="utf-8").read().split("\n") if x]
        texts += chats[::5][:60]  # 每 5 条取 1 条，60 条真实闲聊

    out = []
    with torch.no_grad():
        for t in texts:
            ids = tok(t, truncation=True, max_length=512)["input_ids"]
            b = tok(t, return_tensors="pt", truncation=True, max_length=512)
            cls = bert(**b).last_hidden_state[:, 0]
            v = torch.nn.functional.normalize(cls, p=2, dim=1).numpy()[0]
            h = np.maximum(v @ k1 + b1, 0)
            lg = h @ k2 + b2
            lg = lg - lg.max()
            p = np.exp(lg) / np.exp(lg).sum()
            p_fish = float(p[1])
            label = "fish" if p_fish > 0.5 else "work"
            if max(p_fish, 1 - p_fish) < 0.8:
                label = "uncertain"
            out.append({"text": t, "ids": ids, "pFish": round(p_fish, 6), "label": label})

    dst = os.path.join(ROOT, "dev-tests", "text-ref.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("写出", len(out), "条参考:", dst)


if __name__ == "__main__":
    main()
