# 摸鱼 / 认真 分类模型包（可直接嵌入项目）

**MobileNetV3-Small** 二分类模型，ONNX 格式，输出两类概率（softmax 内置）。**训练数据 628 张真人照片（摸鱼 319 / 认真 309）**，126 张完全未参与训练的真人照片验证集 top1 **83.3%**。

> **许可说明：** 本模型早期版本基于 Mind+（底层 Ultralytics YOLOv8n-cls，AGPL-3.0）训练；
> 为避免 AGPL 许可传染，现行版本已替换为 **MobileNetV3-Small**——
> 以 torchvision 的 BSD-3 预训练权重为起点、在同一数据集上微调，架构与权重许可均宽松合规。
> 推理运行时 onnxruntime 为 MIT 许可。

| 类别索引 | 标签 | 含义 |
|---|---|---|
| 0 | 摸鱼 | 睡觉、趴桌、玩手机、发呆、闲聊、躺卧休息 |
| 1 | 认真 | 写作业、看书、考试、专心办公 |

## 包内容

```
摸鱼认真_模型包/
├── best.onnx            ★ 主模型（6.1 MB，输入 224×224，验证 top1 83.3%）
├── infer.py             开箱即用的推理模块 + 命令行（自动识别输入边长）
├── model_info.json      输入输出规格、预处理、指标（给程序读）
├── labels.json          类别映射
├── data.yaml            Mind+ / YOLO 格式的类别定义（历史遗留）
├── eval_report.json     旧 YOLO 版验证明细（供对比）
└── samples/             两张示例图，可直接冒烟测试
```

## 一、30 秒验证

```bash
pip install onnxruntime numpy pillow
python infer.py samples/sample_slacking.jpg samples/sample_diligent.jpg
# sample_slacking.jpg   摸鱼   backend=onnxruntime
# sample_diligent.jpg   认真   backend=onnxruntime
```

## 二、嵌入 Python 项目

```python
from infer import SlackClassifier

clf = SlackClassifier("best.onnx")          # 只加载一次，复用；输入尺寸自动识别
r = clf.predict("frame.jpg")                # 传路径或 PIL.Image 都行
print(r["label"], r["score"])               # 摸鱼 0.98
```

## 三、嵌入 Node.js / 前端项目

```js
// npm i onnxruntime-node sharp
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const SIZE = 224;
const session = await ort.InferenceSession.create('best.onnx');
const { data } = await sharp('frame.jpg')
  .resize(SIZE, SIZE, { fit: 'cover', position: 'centre' })   // 短边缩放+中心裁剪
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });

// 输入 0~1 即可（ImageNet mean/std 归一化已内置在 ONNX 图内）
const input = new ort.Tensor('float32', Float32Array.from(data, v => v / 255), [1, 3, SIZE, SIZE]);
const out = await session.run({ images: input });
const p = Array.from(out.output0.data);   // 已 softmax：p[0]=摸鱼, p[1]=认真
```

浏览器端用 `onnxruntime-web`，模型同一份，只换 Tensor 构造方式。

## 四、接口规格

| 项 | best.onnx |
|---|---|
| 输入名 | `images` |
| 输入形状 | `[1, 3, 224, 224]` NCHW float32 RGB |
| 数值范围 | `0~1`（`像素/255`，**不做** ImageNet 归一化——归一化已内置在图内） |
| 预处理 | 短边缩放到 224 → 中心裁剪 224×224 |
| 输出名 | `output0`（`[1, 2]`，已含 softmax） |
| 判定 | `argmax`，索引 0=摸鱼，1=认真 |

## 五、指标说明（126 张完全没参与训练的真人照片）

| 模型 | 输入 | 总体 top1 | 摸鱼 | 认真 |
|---|---|---|---|---|
| `best.onnx`（MobileNetV3-Small） | 224×224 | **83.3%** | 81.2% | 85.5% |
| 旧版 `best.onnx`（YOLOv8n-cls，已弃用） | 256×256 | 86.5% | 85.9% | 87.1% |

- 验证集与训练集做过 **md5 全局去重**，零重叠，数字是可信的泛化估计。
- MobileNetV3 版比 YOLOv8 版低约 3 个百分点，换来的是**宽松许可（BSD-3）可闭源分发**；
  认真类召回更高（更少把认真误报成摸鱼），且 5 秒一帧的推理频率下体积与速度几乎不变。

## 六、继续训练

数据集按 `train/摸鱼`、`train/认真`、`val/摸鱼`、`val/认真` 组织；
微调脚本见 `WorkBuddy\2026-11-06-07-35-36\yolo_cls\train_mnv3.py`
（torchvision MobileNetV3-Small，CPU 约 13 分钟）。加数据比调参更有效。
