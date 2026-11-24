/* 阿刺 Pro · 真 3D 建模（Three.js 程序化几何，无外部模型文件）
 * ------------------------------------------------------------------
 * 不是 CSS 切片拼的假 3D：这里每一根棱、每一根刺、盆的收腰都是真几何。
 *   · 主干 —— 参数曲面：半径沿高度起伏（一节一节）+ 绕周向 8 道纵向棱
 *   · 手臂 —— 沿 Catmull-Rom 曲线扫掠的带棱管，端头收成球冠
 *   · 花盆 —— LatheGeometry 旋成（外壁收分、盆沿外翻、内壁折回）
 *   · 刺   —— InstancedMesh，一次 draw call 打完 90 根
 *   · 光   —— 半球光 + 主光 + 冷色轮廓光，配软阴影贴片
 * 全部在本机 GPU 渲染，不联网、不加载任何外部资源。
 */
(function () {
  'use strict';
  if (!window.THREE) return;
  var T = window.THREE;

  /* ---------------- 颜色工具 ---------------- */
  function cssVar(el, name, fb) {
    try {
      var v = getComputedStyle(el).getPropertyValue(name);
      v = (v || '').trim();
      return v || fb;
    } catch (e) { return fb; }
  }
  function shade(hex, k) { // k<1 变暗，k>1 变亮
    var c = new T.Color(hex);
    if (k <= 1) c.multiplyScalar(k);
    else c.lerp(new T.Color(0xffffff), Math.min(1, k - 1));
    return c;
  }

  /* ---------------- 参数曲面：带棱的柱体 ---------------- */
  /* radiusAt(t) / yAt(t) 给出轮廓，ribs 为纵向棱数，amp 为棱的起伏幅度 */
  function ribbedBody(heightSeg, radialSeg, radiusAt, yAt, ribs, amp) {
    var pos = [], idx = [];
    var i, j;
    for (i = 0; i <= heightSeg; i++) {
      var t = i / heightSeg;
      var y = yAt(t);
      var base = Math.max(0.0008, radiusAt(t));
      for (j = 0; j <= radialSeg; j++) {
        var th = (j / radialSeg) * Math.PI * 2;
        var r = base * (1 + amp * Math.cos(ribs * th));
        pos.push(Math.cos(th) * r, y, Math.sin(th) * r);
      }
    }
    var row = radialSeg + 1;
    for (i = 0; i < heightSeg; i++) {
      for (j = 0; j < radialSeg; j++) {
        var a = i * row + j, b = a + row;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    var g = new T.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  /* ---------------- 参数曲面：沿曲线扫掠的带棱管 ---------------- */
  function ribbedTube(curve, radius, ribs, amp, segsAlong, segsAround, capEnd) {
    var frames = curve.computeFrenetFrames(segsAlong, false);
    var pos = [], idx = [], i, j;
    for (i = 0; i <= segsAlong; i++) {
      var t = i / segsAlong;
      var p = curve.getPointAt(t);
      var N = frames.normals[i], B = frames.binormals[i];
      /* 两端收成球冠，中间等半径 */
      var taper = 1;
      if (t < 0.10) taper = Math.sqrt(Math.max(0, 1 - Math.pow((0.10 - t) / 0.10, 2)));
      if (capEnd !== false && t > 0.90) taper = Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.90) / 0.10, 2)));
      for (j = 0; j <= segsAround; j++) {
        var th = (j / segsAround) * Math.PI * 2;
        var r = Math.max(0.0008, radius * taper * (1 + amp * Math.cos(ribs * th)));
        var cx = Math.cos(th) * r, cy = Math.sin(th) * r;
        pos.push(
          p.x + N.x * cx + B.x * cy,
          p.y + N.y * cx + B.y * cy,
          p.z + N.z * cx + B.z * cy
        );
      }
    }
    var row = segsAround + 1;
    for (i = 0; i < segsAlong; i++) {
      for (j = 0; j < segsAround; j++) {
        var a = i * row + j, b = a + row;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    var g = new T.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  /* ---------------- 软阴影贴片（径向渐变，替代 shadow map） ---------------- */
  function shadowTexture() {
    var s = 128, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    var ctx = cv.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.46)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    var tex = new T.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  /* ---------------- 建整个场景 ---------------- */
  function create(canvas, opts) {
    opts = opts || {};
    var compact = !!opts.compact;           // 浮标里的小尺寸
    var renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas: canvas, antialias: !compact, alpha: true, powerPreference: 'low-power' });
    } catch (e) { return null; }
    if (!renderer) return null;
    renderer.setClearAlpha(0);
    if ('outputEncoding' in renderer) renderer.outputEncoding = T.sRGBEncoding;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2));

    var scene = new T.Scene();

    /* 主题色：优先读面板上的设计令牌，退回软件主色 */
    var host = canvas.closest('#pqb-panel, #pqb-fab') || canvas;
    function palette() {
      var teal = cssVar(host, '--pqb-teal', '#17cda8');
      var amber = cssVar(host, '--pqb-amber', '#f5a623');
      var app = document.getElementById('app');
      var dark = !!(app && app.getAttribute('data-theme') === 'dark');
      return {
        dark: dark,
        skin: shade(teal, dark ? 0.82 : 0.74),
        skinDeep: shade(teal, 0.5),
        pot: new T.Color(dark ? '#9c6a44' : '#b3784d'),
        potRim: new T.Color(dark ? '#8a5c39' : '#a26942'),
        soil: new T.Color('#3d2a1a'),
        petal: new T.Color('#ffc36b'),
        core: new T.Color(amber),
        stripe: shade(teal, 0.42),
      };
    }
    var pal = palette();

    var matSkin = new T.MeshStandardMaterial({ color: pal.skin.clone(), roughness: 0.66, metalness: 0.02 });
    var matSkinDeep = new T.MeshStandardMaterial({ color: pal.skinDeep.clone(), roughness: 0.7, metalness: 0.02 });
    var matPot = new T.MeshStandardMaterial({ color: pal.pot.clone(), roughness: 0.92, metalness: 0.0, side: T.DoubleSide });
    var matRim = new T.MeshStandardMaterial({ color: pal.potRim.clone(), roughness: 0.86, metalness: 0.0, side: T.DoubleSide });
    var matSoil = new T.MeshStandardMaterial({ color: pal.soil.clone(), roughness: 1.0, metalness: 0.0 });
    var matSpine = new T.MeshStandardMaterial({ color: new T.Color('#cfe0a4'), roughness: 0.55, metalness: 0.0, emissive: new T.Color('#000000') });
    var matEyeWhite = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.0 });
    /* 上眼皮：跟皮肤同色，压下来就是半睁眼／不耐烦 */
    var matLid = new T.MeshStandardMaterial({ color: pal.skin.clone(), roughness: 0.7, metalness: 0.0 });
    var matPupil = new T.MeshStandardMaterial({ color: new T.Color('#1b2130'), roughness: 0.18, metalness: 0.1 });
    var matGloss = new T.MeshBasicMaterial({ color: 0xffffff });
    var matBrow = new T.MeshStandardMaterial({ color: new T.Color('#1b2130'), roughness: 0.6, transparent: true, opacity: 0 });
    var matMouth = new T.MeshStandardMaterial({ color: new T.Color('#2a1f24'), roughness: 0.5, transparent: true, opacity: 1 });
    var matPetal = new T.MeshStandardMaterial({ color: pal.petal.clone(), roughness: 0.55, metalness: 0.0 });
    var matCore = new T.MeshStandardMaterial({ color: pal.core.clone(), roughness: 0.4, emissive: pal.core.clone(), emissiveIntensity: 0.22 });

    /* 根：整体旋转 / 缩放都挂在这里 */
    var root = new T.Group();
    var swayGroup = new T.Group();      // 呼吸 + 摇摆
    root.add(swayGroup);
    scene.add(root);

    /* ---- 光照 ---- */
    var hemi = new T.HemisphereLight(0xe9f2ff, 0x5a4028, pal.dark ? 0.62 : 0.86);
    scene.add(hemi);
    var key = new T.DirectionalLight(0xfff4e2, pal.dark ? 1.45 : 1.7);
    key.position.set(2.4, 3.6, 2.8);
    scene.add(key);
    var rim = new T.DirectionalLight(0x9fc8ff, pal.dark ? 0.75 : 0.5);
    rim.position.set(-2.8, 1.6, -2.2);
    scene.add(rim);
    var fill = new T.AmbientLight(0xffffff, pal.dark ? 0.16 : 0.12);
    scene.add(fill);

    /* ---- 花盆（旋成） ---- */
    var POT_TOP = 0.60;
    var potPts = [
      new T.Vector2(0.001, 0.00),
      new T.Vector2(0.36, 0.005),
      new T.Vector2(0.395, 0.045),
      new T.Vector2(0.455, 0.20),
      new T.Vector2(0.525, 0.40),
      new T.Vector2(0.575, 0.535),
      new T.Vector2(0.615, 0.565),
      new T.Vector2(0.613, 0.612),
      new T.Vector2(0.548, 0.622),
      new T.Vector2(0.528, 0.45),
      new T.Vector2(0.522, 0.30),
    ];
    var potGeo = new T.LatheGeometry(potPts, 56);
    potGeo.computeVertexNormals();
    var pot = new T.Mesh(potGeo, matPot);
    swayGroup.add(pot);

    /* 盆沿：不用环带，旋成体自身已有外翻沿 */

    /* 土面：稍微起伏的圆盘 */
    var soilSeg = 40;
    var soilGeo = new T.CircleGeometry(0.535, soilSeg);
    var sp = soilGeo.attributes.position;
    for (var si = 0; si < sp.count; si++) {
      var sx = sp.getX(si), sy = sp.getY(si);
      var rr = Math.sqrt(sx * sx + sy * sy) / 0.535;
      sp.setZ(si, (Math.sin(sx * 11) * Math.cos(sy * 13)) * 0.012 * (1 - rr * 0.4));
    }
    soilGeo.computeVertexNormals();
    var soil = new T.Mesh(soilGeo, matSoil);
    soil.rotation.x = -Math.PI / 2;
    soil.position.y = 0.545;
    swayGroup.add(soil);

    /* ---------------- 身体：五种皮肤各自建模 ----------------
     * 皮肤不是换名字、不是换贴图——几何体真的换了：
     *   仙人掌 = 带棱柱状主干 + 两条上翘的手臂
     *   玫瑰   = 细茎 + 花苞身体 + 大花冠 + 叶片 + 茎刺
     *   刺猬   = 圆滚滚身体 + 密而短的刺 + 小耳朵和短脚
     *   板栗   = 球身 + 尖顶 + 底部浅色 + 稀疏短刺
     *   豪猪   = 细长身体 + 突出的吻部 + 粗长刺
     * 脸部（眼/眉/嘴/腮红）是同一套骨架，按每个皮肤的头部位置与大小重新摆放。
     */
    var bodyGroup = new T.Group();
    swayGroup.add(bodyGroup);
    var matLeaf = new T.MeshStandardMaterial({ color: new T.Color('#3f8a5a'), roughness: 0.72, metalness: 0.0 });
    var BODY = { id: 'cactus', faceY: 1.28, faceZ: 0.289, eyeGap: 0.108, faceScale: 1, mouthDY: 0.185, flowerY: 1.805 };

    function disposeTree(o) {
      if (o.geometry) o.geometry.dispose();
      if (o.children && o.children.length) for (var i = 0; i < o.children.length; i++) disposeTree(o.children[i]);
    }
    function clearGroup(g) {
      for (var i = g.children.length - 1; i >= 0; i--) { var o = g.children[i]; g.remove(o); disposeTree(o); }
    }
    /* 一批刺：InstancedMesh，一次 draw call。rad/len 决定粗细长短（刺猬短密、豪猪粗长） */
    function addSpines(list, rad, len) {
      if (!list.length) return;
      var g = new T.ConeGeometry(rad, len, 5);
      g.translate(0, len / 2, 0);
      var inst = new T.InstancedMesh(g, matSpine, list.length);
      var mtx = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), sc = new T.Vector3();
      list.forEach(function (s, i) {
        q.setFromUnitVectors(up, s.n);
        var k = s.s || 1;
        sc.set(k, k * (0.85 + Math.random() * 0.4), k);
        mtx.compose(s.p, q, sc);
        inst.setMatrixAt(i, mtx);
      });
      inst.instanceMatrix.needsUpdate = true;
      bodyGroup.add(inst);
    }
    function v3(x, y, z) { return new T.Vector3(x, y, z); }

    /* ---- 仙人掌：柱状主干 + 双臂 ---- */
    function buildCactusBody() {
      BODY = { id: 'cactus', faceY: 1.28, faceZ: 0.289, eyeGap: 0.108, faceScale: 1, mouthDY: 0.185, flowerY: 1.805 };
      var BASE_Y = 0.50, TRUNK_H = 1.30, TRUNK_R = 0.295;
      function trunkRadius(t) {
        var r = TRUNK_R * (1 + 0.055 * Math.sin(t * Math.PI * 4.6 - 0.4));
        r *= 1 - 0.14 * Math.pow(t, 5);
        if (t > 0.90) {
          var k = (t - 0.90) / 0.10;
          r *= Math.sqrt(Math.max(0, 1 - k * k));
        }
        if (t < 0.05) r *= 0.94;
        return r;
      }
      function trunkY(t) { return BASE_Y + t * TRUNK_H; }
      var trunk = new T.Mesh(ribbedBody(64, 56, trunkRadius, trunkY, 8, 0.055), matSkin);
      bodyGroup.add(trunk);

      function makeArm(pts, rad) {
        var curve = new T.CatmullRomCurve3(pts.map(function (p) { return v3(p[0], p[1], p[2]); }));
        var g = ribbedTube(curve, rad, 7, 0.06, 40, 30, true);
        bodyGroup.add(new T.Mesh(g, matSkin));
        return curve;
      }
      var armCurves = [];
      armCurves.push(makeArm([
        [-0.18, 1.02, 0.03], [-0.36, 1.05, 0.06], [-0.50, 1.16, 0.05],
        [-0.555, 1.36, 0.02], [-0.565, 1.52, 0.0],
      ], 0.145));
      armCurves.push(makeArm([
        [0.18, 1.38, -0.02], [0.37, 1.44, -0.02], [0.52, 1.55, -0.01],
        [0.575, 1.74, 0.0], [0.575, 1.88, 0.0],
      ], 0.128));

      var spineList = [];
      var i, t, th, y, r, nx, nz;
      for (i = 0; i < 42; i++) {
        t = 0.06 + Math.random() * 0.86;
        th = Math.random() * Math.PI * 2;
        y = trunkY(t);
        if (Math.cos(th) > 0.30 && y > 0.92 && y < 1.72) continue;
        r = trunkRadius(t) * (1 + 0.055 * Math.cos(8 * th));
        nx = Math.cos(th); nz = Math.sin(th);
        spineList.push({ p: v3(nx * r, y, nz * r), n: v3(nx, 0.16, nz).normalize(), s: 0.55 + Math.random() * 0.35 });
      }
      armCurves.forEach(function (curve) {
        var frames = curve.computeFrenetFrames(40, false);
        for (var k = 0; k < 9; k++) {
          var tt = 0.12 + Math.random() * 0.72;
          var p = curve.getPointAt(tt);
          var idxF = Math.min(39, Math.floor(tt * 40));
          var N = frames.normals[idxF], B = frames.binormals[idxF];
          var ang = Math.random() * Math.PI * 2;
          var dir = N.clone().multiplyScalar(Math.cos(ang)).add(B.clone().multiplyScalar(Math.sin(ang))).normalize();
          spineList.push({ p: p.clone().add(dir.clone().multiplyScalar(0.13)), n: dir, s: 0.6 + Math.random() * 0.45 });
        }
      });
      BODY.faceZ = trunkRadius((BODY.faceY - BASE_Y) / TRUNK_H) * 0.99;
      addSpines(spineList, 0.0095, 0.042);
    }

    /* ---- 玫瑰：细茎 + 花苞身体 + 大花冠 ---- */
    function buildRoseBody() {
      BODY = { id: 'rose', faceY: 1.14, faceZ: 0.325, eyeGap: 0.102, faceScale: 0.95, mouthDY: 0.175, flowerY: 1.52 };
      var curve = new T.CatmullRomCurve3([
        v3(0.0, 0.50, 0.02), v3(0.035, 0.68, 0.01), v3(-0.02, 0.88, 0.0), v3(0.0, 1.02, 0.0),
      ]);
      bodyGroup.add(new T.Mesh(new T.TubeGeometry(curve, 24, 0.052, 10, false), matSkin));

      /* 花苞身体：脸长在这上面 */
      var bud = new T.Mesh(new T.SphereGeometry(0.36, 36, 28), matSkin);
      bud.scale.set(1.0, 0.98, 0.94);
      bud.position.set(0, 1.12, 0);
      bodyGroup.add(bud);

      /* 花萼：五片尖叶托住花苞 */
      for (var i = 0; i < 5; i++) {
        var a = (i / 5) * Math.PI * 2 + 0.3;
        var cal = new T.Mesh(new T.ConeGeometry(0.075, 0.24, 8), matLeaf);
        cal.position.set(Math.cos(a) * 0.19, 1.37, Math.sin(a) * 0.19);
        cal.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55);
        bodyGroup.add(cal);
      }
      /* 叶子：三片压扁的椭球 */
      [[0.26, 0.86, 0.05, -0.5], [-0.27, 0.73, -0.02, 0.6], [0.19, 1.00, 0.11, -0.28]].forEach(function (L) {
        var leaf = new T.Mesh(new T.SphereGeometry(0.16, 18, 14), matLeaf);
        leaf.scale.set(1.55, 0.16, 0.62);
        leaf.position.set(L[0], L[1], L[2]);
        leaf.rotation.z = L[3];
        leaf.rotation.y = L[3] * 0.6;
        bodyGroup.add(leaf);
      });
      /* 茎刺 */
      var thorns = [];
      for (var k = 0; k < 16; k++) {
        var tt = 0.08 + Math.random() * 0.62;
        var p = curve.getPointAt(tt);
        var ang = Math.random() * Math.PI * 2;
        var n = v3(Math.cos(ang), 0.35, Math.sin(ang)).normalize();
        thorns.push({ p: p.clone().add(n.clone().multiplyScalar(0.05)), n: n, s: 0.5 + Math.random() * 0.3 });
      }
      addSpines(thorns, 0.0105, 0.075);
    }

    /* ---- 刺猬：圆身 + 密短刺 ---- */
    function buildHedgehogBody() {
      BODY = { id: 'hedgehog', faceY: 1.02, faceZ: 0.468, eyeGap: 0.132, faceScale: 0.92, mouthDY: 0.17, flowerY: 1.50 };
      var RX = 0.50, RY = 0.44, RZ = 0.47, CY = 1.00;
      var body = new T.Mesh(new T.SphereGeometry(0.5, 40, 32), matSkin);
      body.scale.set(1.0, RY / 0.5, RZ / 0.5);
      body.position.set(0, CY, 0.02);
      bodyGroup.add(body);

      /* 肚皮：正面下方贴一块浅色 */
      var belly = new T.Mesh(new T.SphereGeometry(0.5, 32, 24), matSkinDeep);
      belly.scale.set(0.78, 0.55, 0.30);
      belly.position.set(0, 0.86, 0.30);
      bodyGroup.add(belly);

      [-1, 1].forEach(function (s) {
        var ear = new T.Mesh(new T.SphereGeometry(0.10, 18, 14), matSkin);
        ear.position.set(s * 0.27, CY + 0.34, 0.12);
        ear.scale.set(1, 1, 0.7);
        bodyGroup.add(ear);
        var foot = new T.Mesh(new T.SphereGeometry(0.15, 18, 14), matSkinDeep);
        foot.scale.set(1, 0.55, 1.25);
        foot.position.set(s * 0.22, 0.58, 0.16);
        bodyGroup.add(foot);
      });

      var list = [];
      for (var i = 0; i < 150; i++) {
        var u = Math.random() * Math.PI * 2;
        var ny = Math.pow(Math.random(), 0.72);
        var rr = Math.sqrt(Math.max(0, 1 - ny * ny));
        var nx = Math.cos(u) * rr, nz = Math.sin(u) * rr;
        if (nz > 0.55 && ny < 0.5) continue;  /* 正脸留空 */
        list.push({
          p: v3(nx * RX, CY + ny * RY, 0.02 + nz * RZ),
          n: v3(nx, ny * 0.9 + 0.12, nz).normalize(),
          s: 0.55 + Math.random() * 0.3,
        });
      }
      addSpines(list, 0.0125, 0.10);
    }

    /* ---- 板栗：球身 + 尖顶 + 稀刺 ---- */
    function buildChestnutBody() {
      BODY = { id: 'chestnut', faceY: 0.97, faceZ: 0.452, eyeGap: 0.122, faceScale: 0.9, mouthDY: 0.165, flowerY: 1.42 };
      var R = 0.47, CY = 0.95;
      var body = new T.Mesh(new T.SphereGeometry(R, 40, 32), matSkin);
      body.scale.set(1, 0.94, 0.95);
      body.position.set(0, CY, 0.02);
      bodyGroup.add(body);

      /* 尖顶：板栗的标志 */
      var tip = new T.Mesh(new T.ConeGeometry(0.17, 0.36, 20), matSkinDeep);
      tip.position.set(0, CY + R * 0.94 + 0.12, 0.0);
      bodyGroup.add(tip);

      /* 底部浅色圆盘 */
      var base = new T.Mesh(new T.SphereGeometry(0.30, 26, 18), matSkinDeep);
      base.scale.set(1, 0.42, 1);
      base.position.set(0, 0.64, 0.02);
      bodyGroup.add(base);

      var list = [];
      for (var i = 0; i < 52; i++) {
        var u = Math.random() * Math.PI * 2;
        var ny = Math.pow(Math.random(), 0.6);
        var rr = Math.sqrt(Math.max(0, 1 - ny * ny));
        var nx = Math.cos(u) * rr, nz = Math.sin(u) * rr;
        if (nz > 0.5 && ny < 0.5) continue;
        list.push({
          p: v3(nx * 0.47, CY + ny * 0.44, 0.02 + nz * 0.447),
          n: v3(nx, ny + 0.12, nz).normalize(),
          s: 0.6 + Math.random() * 0.35,
        });
      }
      addSpines(list, 0.011, 0.075);
    }

    /* ---- 豪猪：细长身 + 长刺 + 吻部 ---- */
    function buildPorcupineBody() {
      BODY = { id: 'porcupine', faceY: 1.55, faceZ: 0.281, eyeGap: 0.098, faceScale: 0.84, mouthDY: 0.155, flowerY: 1.94 };
      var body = new T.Mesh(new T.SphereGeometry(0.5, 36, 28), matSkin);
      body.scale.set(0.80, 1.05, 0.78);
      body.position.set(0, 1.02, -0.02);
      bodyGroup.add(body);

      var head = new T.Mesh(new T.SphereGeometry(0.30, 32, 26), matSkin);
      head.scale.set(1, 0.94, 0.96);
      head.position.set(0, 1.55, 0.0);
      bodyGroup.add(head);

      var snout = new T.Mesh(new T.ConeGeometry(0.12, 0.20, 16), matSkinDeep);
      snout.rotation.x = Math.PI / 2;
      snout.position.set(0, 1.49, 0.29);
      bodyGroup.add(snout);

      [-1, 1].forEach(function (s) {
        var ear = new T.Mesh(new T.SphereGeometry(0.075, 16, 12), matSkin);
        ear.position.set(s * 0.22, 1.76, -0.02);
        bodyGroup.add(ear);
        var foot = new T.Mesh(new T.SphereGeometry(0.12, 16, 12), matSkinDeep);
        foot.scale.set(1, 0.55, 1.2);
        foot.position.set(s * 0.18, 0.60, 0.12);
        bodyGroup.add(foot);
      });

      var list = [];
      for (var i = 0; i < 95; i++) {
        var u = Math.random() * Math.PI * 2;
        var ny = Math.pow(Math.random(), 0.55);
        var rr = Math.sqrt(Math.max(0, 1 - ny * ny));
        var nx = Math.cos(u) * rr, nz = Math.sin(u) * rr;
        if (nz > 0.35 && ny < 0.8) continue;  /* 脸和吻留空 */
        list.push({
          p: v3(nx * 0.40, 1.02 + ny * 0.52, -0.02 + nz * 0.39),
          n: v3(nx, ny * 0.7 + 0.35, nz).normalize(),
          s: 0.9 + Math.random() * 0.5,
        });
      }
      addSpines(list, 0.020, 0.30);
    }

    var BODY_BUILDERS = {
      cactus: buildCactusBody, rose: buildRoseBody, hedgehog: buildHedgehogBody,
      chestnut: buildChestnutBody, porcupine: buildPorcupineBody,
    };
    function buildBody(id) {
      clearGroup(bodyGroup);
      (BODY_BUILDERS[id] || buildCactusBody)();
    }
    buildBody('cactus');

    /* ---- 脸（同一套骨架，按 BODY 摆放） ---- */
    function eyeGroup(sign) {
      var g = new T.Group();
      var white = new T.Mesh(new T.SphereGeometry(0.088, 26, 20), matEyeWhite);
      white.scale.set(1, 1.06, 0.72);
      g.add(white);
      var pupil = new T.Mesh(new T.SphereGeometry(0.058, 22, 18), matPupil);
      pupil.position.set(sign * 0.006, -0.004, 0.052);
      pupil.scale.set(1, 1.08, 0.7);
      g.add(pupil);
      var gl = new T.Mesh(new T.SphereGeometry(0.019, 12, 10), matGloss);
      gl.position.set(sign * -0.012, 0.022, 0.083);
      g.add(gl);
      var gl2 = new T.Mesh(new T.SphereGeometry(0.009, 10, 8), matGloss);
      gl2.position.set(sign * 0.016, -0.015, 0.086);
      g.add(gl2);
      /* 上眼皮（球冠）：平时藏在眼睛上方，lid 越大压得越低 = 半睁眼 */
      var lid = new T.Mesh(new T.SphereGeometry(0.0945, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), matLid);
      lid.position.set(0, 0.118, 0.004);
      lid.visible = false;
      g.add(lid);
      g.userData.pupil = pupil;
      g.userData.lid = lid;
      g.userData.sign = sign;
      return g;
    }
    var eyeL = eyeGroup(-1), eyeR = eyeGroup(1);
    eyeL.rotation.y = -0.16; eyeR.rotation.y = 0.16;
    swayGroup.add(eyeL); swayGroup.add(eyeR);

    function browMesh() {
      var geo = new T.CapsuleGeometry(0.017, 0.082, 4, 10);
      geo.rotateZ(Math.PI / 2);
      return new T.Mesh(geo, matBrow.clone());
    }
    var browL = browMesh(), browR = browMesh();
    browL.rotation.z = 0.16; browR.rotation.z = -0.16;
    browL.rotation.y = -0.16; browR.rotation.y = 0.16;
    swayGroup.add(browL); swayGroup.add(browR);

    /* 腮红：Sprite 一直朝相机，边缘自然虚化 */
    function blushSprite() {
      var s = 64, cv = document.createElement('canvas');
      cv.width = cv.height = s;
      var c = cv.getContext('2d');
      var gr = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, 'rgba(255,124,150,0.95)');
      gr.addColorStop(0.55, 'rgba(255,124,150,0.42)');
      gr.addColorStop(1, 'rgba(255,124,150,0)');
      c.fillStyle = gr; c.fillRect(0, 0, s, s);
      var m = new T.SpriteMaterial({ map: new T.CanvasTexture(cv), transparent: true, opacity: 0, depthWrite: false });
      var sp2 = new T.Sprite(m);
      sp2.scale.set(0.145, 0.10, 1);
      return sp2;
    }
    var blushL = blushSprite(), blushR = blushSprite();
    swayGroup.add(blushL); swayGroup.add(blushR);

    /* 嘴：半环（rotation.z = PI 是微笑，= 0 是皱眉） */
    var mouthRoot = new T.Group();     // 只定位置：表情缩放不作用在这一层
    var mouthGroup = new T.Group();    // 唇形（那条弧）挂这层，吃表情的 scale/rotation
    var mouthGeo = new T.TorusGeometry(0.072, 0.0165, 10, 26, Math.PI);
    var mouth = new T.Mesh(mouthGeo, matMouth);
    mouthGroup.add(mouth);
    mouthRoot.add(mouthGroup);

    /* 说话时张开的「O」：一个压扁的圆盘，和弧线交替出现——
     * 只缩放弧线的 y 永远只是「更扁的线」，张不成圈。 */
    var matOpen = new T.MeshStandardMaterial({
      color: new T.Color('#2a1f24'), roughness: 0.55, transparent: true, opacity: 0, depthWrite: false,
    });
    var mouthOpen = new T.Mesh(new T.CircleGeometry(0.062, 26), matOpen);
    mouthOpen.position.set(0, 0.006, 0.008);
    mouthOpen.visible = false;
    mouthRoot.add(mouthOpen);
    mouthGroup.rotation.z = Math.PI;
    swayGroup.add(mouthRoot);

    /* 按当前皮肤把五官摆到头上（换皮肤时重摆，不重建） */
    function layoutFace() {
      var s = BODY.faceScale, y = BODY.faceY, z = BODY.faceZ, g = BODY.eyeGap;
      eyeL.position.set(-g, y, z + 0.012);
      eyeR.position.set(g, y, z + 0.012);
      eyeL.scale.setScalar(s); eyeR.scale.setScalar(s);
      browL.position.set(-g * 1.06, y + 0.135 * s, z + 0.045);
      browR.position.set(g * 1.06, y + 0.135 * s, z + 0.045);
      browL.scale.setScalar(s); browR.scale.setScalar(s);
      blushL.position.set(-g * 1.6, y - 0.095 * s, z + 0.055);
      blushR.position.set(g * 1.6, y - 0.095 * s, z + 0.055);
      mouthRoot.position.set(0, y - BODY.mouthDY, z + 0.045);
      mouthRoot.scale.setScalar(s);
    }

    /* ---- 顶上花：瓣数/大小也随皮肤（玫瑰是大花，豪猪几乎没有） ---- */
    var flower = new T.Group();
    function buildFlower(id) {
      clearGroup(flower);
      var cfg = {
        cactus: { n: 6, r: 0.098, s: 1.0 },
        rose: { n: 9, r: 0.155, s: 1.32 },
        hedgehog: { n: 5, r: 0.062, s: 0.75 },
        chestnut: { n: 4, r: 0.055, s: 0.62 },
        porcupine: { n: 3, r: 0.055, s: 0.58 },
      }[id] || { n: 6, r: 0.098, s: 1.0 };
      var petalGeo = new T.SphereGeometry(0.10, 16, 12);
      for (var i = 0; i < cfg.n; i++) {
        var a = (i / cfg.n) * Math.PI * 2;
        var petal = new T.Mesh(petalGeo, matPetal);
        petal.position.set(Math.cos(a) * cfg.r, 0.012, Math.sin(a) * cfg.r);
        petal.scale.set(0.78 * cfg.s, 0.62 * cfg.s, 1.0 * cfg.s);
        petal.rotation.y = -a;
        petal.rotation.z = 0.55;
        flower.add(petal);
      }
      var core = new T.Mesh(new T.SphereGeometry(0.07 * cfg.s, 18, 14), matCore);
      core.scale.set(1, 0.85, 1);
      core.position.y = 0.055 * cfg.s;
      flower.add(core);
      flower.position.set(0, BODY.flowerY, 0);
      flower.rotation.z = -0.08;
    }
    buildFlower('cactus');
    layoutFace();
    swayGroup.add(flower);

    /* ---- 软阴影 ---- */
    var shadow = new T.Mesh(
      new T.PlaneGeometry(1.75, 1.75),
      new T.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.9 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.006;
    root.add(shadow);

    /* ---- 相机 ---- */
    var camera = new T.PerspectiveCamera(28, 1, 0.1, 60);
    var targetY = 1.02;
    camera.position.set(0, 1.32, 5.4);
    camera.lookAt(0, targetY, 0);

    function resize() {
      var w = canvas.clientWidth || canvas.parentNode.clientWidth || 100;
      var h = canvas.clientHeight || canvas.parentNode.clientHeight || 110;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      var aspect = w / h;
      camera.aspect = aspect;
      /* 竖长画布要退远一点，别把花盆和花切掉 */
      var needH = 2.34;
      var vFov = camera.fov * Math.PI / 180;
      var dist = (needH / 2) / Math.tan(vFov / 2);
      if (aspect < 0.92) dist *= Math.min(1.45, 0.92 / Math.max(0.5, aspect));
      camera.position.z = dist;
      camera.updateProjectionMatrix();
    }
    resize();
    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(canvas); }

    /* ---- 情绪 ---- */
    /* 每个 mood 都是一整套「建模」：五官 + 皮肤色调 + 刺色 + 下垂姿态 + 花冠大小 + 核心发光。
     * tint/spine 为 null 时用主题默认色（由 palette() 决定）；非 null 时覆盖为状态专属配色。 */
    var MOODS = {
      idle:         { eyeY: 1, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1, mouthSY: 1, blush: 0,          tint: null,      spine: null,      droop: 0,    flower: 1,    glow: 0.22 },
      happy:        { eyeY: 0.56, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1.2, mouthSY: 1.25, blush: 0.9, tint: '#4fe0b4', spine: '#e6f5b0', droop: -0.05, flower: 1.12, glow: 0.42 },
      smirk:        { eyeY: 0.5, brow: 0.55, browTilt: 0.5, mouthRot: Math.PI - 0.34, mouthSX: 1.05, mouthSY: 0.85, blush: 0.18, tint: null, spine: null, droop: 0, flower: 1, glow: 0.26 },
      angry:        { eyeY: 0.82, brow: 1, browTilt: -1, mouthRot: 0.06, mouthSX: 1.06, mouthSY: 0.9, blush: 0.42, tint: '#e0645a', spine: '#ffb28a', droop: -0.02, flower: 0.9,  glow: 0.5 },
      sleep:        { eyeY: 0.09, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 0.42, mouthSY: 0.55, blush: 0, tint: '#6a8f86', spine: '#8fa79a', droop: 0.12, flower: 0.82, glow: 0.08 },
      listen:       { eyeY: 1.34, brow: 0.35, browTilt: 0.2, mouthRot: Math.PI, mouthSX: 0.62, mouthSY: 0.62, blush: 0.24, tint: null, spine: null, droop: 0, flower: 1, glow: 0.3 },
      surprised:    { eyeY: 1.32, brow: 1, browTilt: 0.1, mouthRot: Math.PI, mouthSX: 0.46, mouthSY: 1.45, blush: 0.3, tint: null, spine: null, droop: -0.08, flower: 1.08, glow: 0.34 },
      sad:          { eyeY: 0.72, brow: 0.6, browTilt: -0.7, mouthRot: 0.18, mouthSX: 0.9, mouthSY: 0.8, blush: 0.12, tint: '#7a9c8a', spine: '#9bab92', droop: 0.16, flower: 0.72, glow: 0.1 },
      /* 失望：整个人灰掉、刺耷拉、花冠萎缩、垂头丧气——与 sad 比更灰更蔫 */
      disappointed: { eyeY: 0.5, brow: 0.75, browTilt: -0.9, mouthRot: 0.3, mouthSX: 0.82, mouthSY: 0.6, blush: 0, tint: '#6f7d78', spine: '#8a938c', droop: 0.28, flower: 0.55, glow: 0.04 },
      /* 战斗态：通体泛红、刺竖起、花冠张开、核心高亮 */
      fight:        { eyeY: 1.15, brow: 1, browTilt: -0.6, mouthRot: 0.1, mouthSX: 1.12, mouthSY: 0.95, blush: 0.5, tint: '#e0554f', spine: '#ffd08a', droop: -0.1, flower: 1.2, glow: 0.72 },
    };
    var cur = { eyeY: 1, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1, mouthSY: 1, blush: 0, droop: 0, flower: 1, glow: 0.22 };
    var want = MOODS.idle;
    /* 皮肤（头像建模）：基础色/刺色/花瓣色/花冠缩放。
     * 心情的 tint 优先（生气泛红、失望发灰），没心情色时用皮肤底色。 */
    var skinLook = { tint: null, spine: null, petal: null, flower: 1 };
    /* 状态配色：目标色 + 当前色（用 lerp 平滑过渡，做出「建模随状态改变」的效果） */
    var wantSkin = new T.Color(pal.skin), wantSpine = new T.Color('#cfe0a4');
    var curSkin = new T.Color(pal.skin), curSpine = new T.Color('#cfe0a4');
    function applyWantColors() {
      /* 皮肤不随心情变：体色/刺色只由皮肤（或主题）决定。
       * 心情只改表情（眼/眉/嘴/腮红）+ 轻微体态（droop），不动配色、不动花冠。 */
      wantSkin = skinLook.tint ? new T.Color(skinLook.tint) : pal.skin.clone();
      wantSpine = skinLook.spine ? new T.Color(skinLook.spine) : new T.Color('#cfe0a4');
    }
    var mood = 'idle', talkUntil = 0, talkingOn = false;
    var moodUntil = 0;   /* 临时表情多久后自己回到 idle */
    var blink = 0, blinkNext = 2 + Math.random() * 3;
    var rotY = 0, rotCur = 0, dragging = false, spin = -0.18;
    /* 摇一摇：短促左右甩头 + 原地蹦两下，时间到了自动停 */
    var wiggleUntil = 0;
    /* 跳一跳：两下抛物线 */
    var jumpStart = 0, jumpUntil = 0;
    var clock = new T.Clock();

    function setMood(m) {
      mood = MOODS[m] ? m : 'idle';
      want = MOODS[mood];
      applyWantColors();
    }
    function setTalking(on) {
      talkingOn = !!on;
      /* 念一段可能好几秒：只要 talkingOn 为 true 就一直张合，talkUntil 只做看门狗 */
      talkUntil = on ? performance.now() + 15000 : 0;
    }

    /* ---- 帧循环 ---- */
    var raf = null, last = 0, running = true;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!running) return;
      var dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      var fpsCap = compact ? 26 : 60;
      if (now - (frame._t || 0) < 1000 / fpsCap - 1) return;
      frame._t = now;

      var t = now / 1000;
      /* 平滑趋近目标表情 */
      var k = Math.min(1, dt * 9);
      cur.eyeY += (want.eyeY - cur.eyeY) * k;
      cur.brow += (want.brow - cur.brow) * k;
      cur.browTilt += (want.browTilt - cur.browTilt) * k;
      cur.mouthRot += (want.mouthRot - cur.mouthRot) * k;
      cur.mouthSX += (want.mouthSX - cur.mouthSX) * k;
      cur.mouthSY += (want.mouthSY - cur.mouthSY) * k;
      cur.blush += (want.blush - cur.blush) * k;
      cur.droop += (want.droop - cur.droop) * k;
      /* 花冠大小只跟皮肤（和等级）走，不随心情变——心情只挂在脸上 */
      cur.flower += (1 - cur.flower) * k;
      cur.glow += (want.glow - cur.glow) * k;
      /* 建模配色平滑过渡 */
      curSkin.lerp(wantSkin, k);
      curSpine.lerp(wantSpine, k);
      matSkin.color.copy(curSkin);
      matSkinDeep.color.copy(curSkin).multiplyScalar(0.62);
      matSpine.color.copy(curSpine);
      matCore.emissiveIntensity = cur.glow;

      /* 眨眼 */
      blinkNext -= dt;
      if (blinkNext <= 0) { blink = 1; blinkNext = 2.6 + Math.random() * 4.2; }
      if (blink > 0) blink = Math.max(0, blink - dt * 5.2);
      var eyeY = cur.eyeY * (1 - Math.sin(blink * Math.PI) * 0.94);

      eyeL.scale.y = eyeY; eyeR.scale.y = eyeY;
      browL.material.opacity = cur.brow; browR.material.opacity = cur.brow;
      browL.rotation.z = 0.16 + cur.browTilt * 0.42;
      browR.rotation.z = -0.16 - cur.browTilt * 0.42;
      browL.position.y = BODY.faceY + 0.135 * BODY.faceScale + (cur.browTilt < 0 ? -0.012 : 0.008);
      browR.position.y = browL.position.y;
      blushL.material.opacity = cur.blush * 0.9;
      blushR.material.opacity = cur.blush * 0.9;

      if (talkingOn && now > talkUntil - 4000) talkUntil = now + 15000;  /* 长句续命 */
      var talk = talkingOn && now < talkUntil;
      var mouthSY = cur.mouthSY;
      /* 口型：0 = 闭嘴（一条弧），1 = 张成一个圈。12.5 rad/s 大约一秒两下 */
      var open = 0;
      if (talk) {
        open = Math.pow(Math.abs(Math.sin(t * 12.5)), 0.7);
        mouthSY *= 0.72 + 0.5 * open;   /* 张嘴时弧线跟着撑开一点 */
      }
      mouthGroup.scale.set(cur.mouthSX, mouthSY, 1);
      mouthGroup.rotation.z = cur.mouthRot;
      /* 张开时弧线让位、圆盘长出来，看着就是嘴从一条线变成 O。
       * 弧线要「干净地消失」——留一点残影就变成半张嘴，不是圈。 */
      if (open > 0.34) {
        matMouth.opacity = 0;
        mouth.visible = false;
      } else {
        mouth.visible = true;
        matMouth.opacity = 1 - open * 2.4;
      }
      if (open > 0.08) {
        mouthOpen.visible = true;
        mouthOpen.scale.set(1 + open * 0.2, 0.18 + open * 1.05, 1);
        matOpen.opacity = Math.min(1, open * 2.6);
      } else if (mouthOpen.visible) {
        mouthOpen.visible = false;
        matOpen.opacity = 0;
      }

      /* 呼吸 + 摇摆 */
      if (!dragging) spin += dt * 0.22;
      /* 转向目标用缓动追，按钮点一下不会突跳 */
      rotCur += (rotY - rotCur) * Math.min(1, dt * 8);
      var baseRot = dragging ? rotY : (Math.sin(t * 0.36) * 7 + rotCur);
      /* 摇一摇：左右甩 + 上下蹦，最后 0.4 秒自己收力 */
      var wag = 0, hop = 0;
      if (now < wiggleUntil) {
        var left = (wiggleUntil - now) / 1000;
        var force = Math.min(1, left * 1.5);
        wag = Math.sin(now / 38) * 17 * force;
        hop = Math.abs(Math.sin(now / 55)) * 0.055 * force;
      }
      /* 跳一跳：两下抛物线，落地那下轻一点 */
      if (now < jumpUntil) {
        var jp = (now - jumpStart) / Math.max(1, jumpUntil - jumpStart);
        hop += Math.abs(Math.sin(jp * Math.PI * 2)) * 0.17;
      }
      /* 临时表情到点自己收敛，别一直瞪着 / 一直笑 */
      if (moodUntil && now > moodUntil) { moodUntil = 0; setMood('idle'); }
      root.rotation.y = ((baseRot + wag) * Math.PI) / 180;
      root.position.y = hop - Math.max(0, cur.droop) * 0.06; // 蔫巴时整体下沉
      /* droop：垂头（前倾）+ 呼吸幅度变小；精神时略仰头 */
      root.rotation.x = Math.sin(t * 0.42) * 0.012 + cur.droop * 0.22;
      var breathe = 1 + Math.sin(t * 1.15) * (0.008 - Math.max(0, cur.droop) * 0.006);
      swayGroup.scale.set(1 + (cur.flower - 1) * 0.06, breathe, 1 + (cur.flower - 1) * 0.06);
      swayGroup.position.y = Math.sin(t * 1.15) * 0.005;
      /* 花冠：蔫巴时下垂并缩小、精神时张开 */
      flower.rotation.y = Math.sin(t * 0.7) * 0.25;
      flower.rotation.x = cur.droop * 0.5;
      flower.scale.setScalar(Math.max(0.02, Math.max(0.3, cur.flower) * (flower.userData.levelScale || 1) * skinLook.flower));
      shadow.scale.setScalar(1 + Math.sin(t * 1.15) * 0.01);

      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    return {
      setMood: setMood,
      setTalking: setTalking,
      setRotY: function (deg) { rotY = Math.max(-80, Math.min(80, deg)); },
      /* 相对转：按钮用这个，正数向右、负数向左。返回转完的角度 */
      turn: function (deg) { rotY = Math.max(-80, Math.min(80, rotY + (Number(deg) || 0))); return rotY; },
      /* 摇一摇：默认甩 0.9 秒，摇完自己收 */
      wiggle: function (ms) { wiggleUntil = performance.now() + (Number(ms) || 900); },
      /* 跳一跳：默认 1 秒两下 */
      jump: function (ms) { jumpStart = performance.now(); jumpUntil = jumpStart + (Number(ms) || 1000); },
      /* 带时限的表情：过一会儿自己回到 idle */
      moodFor: function (m, ms) { setMood(m); moodUntil = performance.now() + (Number(ms) || 2400); },
      /* 战友状态 → 建模：失望时强制蔫巴灰暗造型；战斗时泛红竖刺；否则按心情。
       * 等级越高花冠略大，体现「成长」。 */
      setCompanionState: function (state) {
        var s = state || {};
        /* 皮肤：换底色/刺色/花瓣色，花冠大小也跟着变（玫瑰大、板栗小、豪猪几乎没有） */
        if (s.skin) {
          /* 换皮肤 = 真的重新建模（几何体重建 + 五官重摆），不是改个色 */
          if (s.skin.id && s.skin.id !== BODY.id) {
            buildBody(s.skin.id);
            buildFlower(s.skin.id);
            layoutFace();
          }
          skinLook.tint = s.skin.tint || null;
          skinLook.spine = s.skin.spine || null;
          skinLook.petal = s.skin.petal || null;
          skinLook.flower = Math.max(0.05, Number(s.skin.flower) || 1);
          matPetal.color.copy(s.skin.petal ? new T.Color(s.skin.petal) : pal.petal);
          /* core 为空 = 回到主题默认（重置时用） */
          matCore.color.copy(s.skin.core ? new T.Color(s.skin.core) : pal.core);
          matCore.emissive.copy(matCore.color);
          applyWantColors();
        }
        if (s.disappointed) setMood('disappointed');
        else if (s.fighting) setMood('fight');
        else if (s.mood && MOODS[s.mood]) setMood(s.mood);
        if (s.level) flower.userData.levelScale = 1 + Math.min(0.25, (Number(s.level) || 1) / 400);
        moodUntil = 0; // 状态造型是持久的，不要被临时表情计时器收回
      },
      rotDeg: function () { return rotY; },
      mood: function () { return mood; },
      isTalking: function () { return !!(talkingOn && performance.now() < talkUntil); },
      startDrag: function () { dragging = true; },
      endDrag: function () { dragging = false; },
      pause: function () { running = false; },
      resume: function () { running = true; last = performance.now(); },
      refreshTheme: function () {
        pal = palette();
        applyWantColors(); // 皮肤底色/心情色都按新主题重算，curSkin 在帧循环里平滑过去
        matSkin.color.copy(curSkin);
        matSkinDeep.color.copy(curSkin).multiplyScalar(0.62);
        matPot.color.copy(pal.pot);
        matRim.color.copy(pal.potRim);
        matSoil.color.copy(pal.soil);
        matPetal.color.copy(pal.petal);
        matCore.color.copy(pal.core);
        matCore.emissive.copy(pal.core);
        hemi.intensity = pal.dark ? 0.62 : 0.86;
        key.intensity = pal.dark ? 1.45 : 1.7;
        rim.intensity = pal.dark ? 0.75 : 0.5;
        fill.intensity = pal.dark ? 0.16 : 0.12;
      },
      resize: resize,
      dispose: function () {
        running = false;
        cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        scene.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach(function (m) { m.dispose(); });
            else o.material.dispose();
          }
        });
        renderer.dispose();
      },
    };
  }

  window.PQBuddy3D = { create: create, hasGL: !!window.THREE };
})();
