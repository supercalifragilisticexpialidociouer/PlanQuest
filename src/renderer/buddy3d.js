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
    var matSpine = new T.MeshStandardMaterial({ color: new T.Color('#cfe0a4'), roughness: 0.55, metalness: 0.0 });
    var matEyeWhite = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.0 });
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

    /* ---- 主干（带棱的参数曲面） ---- */
    var BASE_Y = 0.50, TRUNK_H = 1.30, TRUNK_R = 0.295;
    function trunkRadius(t) {
      var r = TRUNK_R * (1 + 0.055 * Math.sin(t * Math.PI * 4.6 - 0.4));
      r *= 1 - 0.14 * Math.pow(t, 5);       // 顶部微收
      if (t > 0.90) {                       // 顶球冠
        var k = (t - 0.90) / 0.10;
        r *= Math.sqrt(Math.max(0, 1 - k * k));
      }
      if (t < 0.05) r *= 0.94;              // 底部微收
      return r;
    }
    function trunkY(t) { return BASE_Y + t * TRUNK_H; }
    var trunkGeo = ribbedBody(64, 56, trunkRadius, trunkY, 8, 0.055);
    var trunk = new T.Mesh(trunkGeo, matSkin);
    swayGroup.add(trunk);

    /* ---- 手臂（沿曲线扫掠） ---- */
    function makeArm(pts, rad) {
      var curve = new T.CatmullRomCurve3(pts.map(function (p) { return new T.Vector3(p[0], p[1], p[2]); }));
      var g = ribbedTube(curve, rad, 7, 0.06, 40, 30, true);
      var m = new T.Mesh(g, matSkin);
      swayGroup.add(m);
      return curve;
    }
    var armCurves = [];
    /* 左臂：先横出再上翘（略低） */
    armCurves.push(makeArm([
      [-0.18, 1.02, 0.03], [-0.36, 1.05, 0.06], [-0.50, 1.16, 0.05],
      [-0.555, 1.36, 0.02], [-0.565, 1.52, 0.0],
    ], 0.145));
    /* 右臂：更高，先横出再上翘 */
    armCurves.push(makeArm([
      [0.18, 1.38, -0.02], [0.37, 1.44, -0.02], [0.52, 1.55, -0.01],
      [0.575, 1.74, 0.0], [0.575, 1.88, 0.0],
    ], 0.128));

    /* ---- 刺（InstancedMesh，一次 draw call） ---- */
    var spineList = [];
    (function () {
      var i, t, th, y, r, nx, ny, nz;
      /* 主干上的刺：避开正脸（避让区放宽） */
      for (i = 0; i < 42; i++) {
        t = 0.06 + Math.random() * 0.86;
        th = Math.random() * Math.PI * 2;
        y = trunkY(t);
        if (Math.cos(th) > 0.30 && y > 0.92 && y < 1.72) continue;
        r = trunkRadius(t) * (1 + 0.055 * Math.cos(8 * th));
        nx = Math.cos(th); nz = Math.sin(th);
        spineList.push({ p: new T.Vector3(nx * r, y, nz * r), n: new T.Vector3(nx, 0.16, nz).normalize(), s: 0.55 + Math.random() * 0.35 });
      }
      /* 手臂上的刺 */
      armCurves.forEach(function (curve) {
        for (var k = 0; k < 9; k++) {
          var tt = 0.12 + Math.random() * 0.72;
          var p = curve.getPointAt(tt);
          var frames = curve.computeFrenetFrames(40, false);
          var idxF = Math.min(39, Math.floor(tt * 40));
          var N = frames.normals[idxF], B = frames.binormals[idxF];
          var ang = Math.random() * Math.PI * 2;
          var dir = N.clone().multiplyScalar(Math.cos(ang)).add(B.clone().multiplyScalar(Math.sin(ang))).normalize();
          spineList.push({ p: p.clone().add(dir.clone().multiplyScalar(0.13)), n: dir, s: 0.6 + Math.random() * 0.45 });
        }
      });
    })();
    if (spineList.length) {
      var spineGeo = new T.ConeGeometry(0.0095, 0.042, 5);
      spineGeo.translate(0, 0.021, 0);
      var inst = new T.InstancedMesh(spineGeo, matSpine, spineList.length);
      var mtx = new T.Matrix4(), q = new T.Quaternion(), up = new T.Vector3(0, 1, 0), sc = new T.Vector3();
      spineList.forEach(function (s, i) {
        q.setFromUnitVectors(up, s.n);
        sc.set(s.s, s.s * (0.85 + Math.random() * 0.4), s.s);
        mtx.compose(s.p, q, sc);
        inst.setMatrixAt(i, mtx);
      });
      inst.instanceMatrix.needsUpdate = true;
      swayGroup.add(inst);
    }

    /* ---- 脸 ---- */
    var FACE_Y = 1.28;               // 眼睛高度
    var FACE_Z = trunkRadius((FACE_Y - BASE_Y) / TRUNK_H) * 0.99;

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
      return g;
    }
    var eyeL = eyeGroup(-1), eyeR = eyeGroup(1);
    eyeL.position.set(-0.108, FACE_Y, FACE_Z + 0.012);
    eyeR.position.set(0.108, FACE_Y, FACE_Z + 0.012);
    eyeL.rotation.y = -0.16; eyeR.rotation.y = 0.16;
    swayGroup.add(eyeL); swayGroup.add(eyeR);

    /* 眉毛 */
    function browMesh() {
      var geo = new T.CapsuleGeometry(0.017, 0.082, 4, 10);
      geo.rotateZ(Math.PI / 2);
      return new T.Mesh(geo, matBrow.clone());
    }
    var browL = browMesh(), browR = browMesh();
    browL.position.set(-0.115, FACE_Y + 0.135, FACE_Z + 0.045);
    browR.position.set(0.115, FACE_Y + 0.135, FACE_Z + 0.045);
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
    blushL.position.set(-0.175, FACE_Y - 0.095, FACE_Z + 0.055);
    blushR.position.set(0.175, FACE_Y - 0.095, FACE_Z + 0.055);
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

    mouthRoot.position.set(0, FACE_Y - 0.185, FACE_Z + 0.045);
    mouthGroup.rotation.z = Math.PI;
    swayGroup.add(mouthRoot);

    /* ---- 顶上小花 ---- */
    var flower = new T.Group();
    var petalGeo = new T.SphereGeometry(0.10, 16, 12);
    var petals = 6;
    for (var pi = 0; pi < petals; pi++) {
      var a = (pi / petals) * Math.PI * 2;
      var petal = new T.Mesh(petalGeo, matPetal);
      petal.position.set(Math.cos(a) * 0.098, 0.012, Math.sin(a) * 0.098);
      petal.scale.set(0.78, 0.62, 1.0);
      petal.rotation.y = -a;
      petal.rotation.z = 0.55;
      flower.add(petal);
    }
    var core = new T.Mesh(new T.SphereGeometry(0.07, 18, 14), matCore);
    core.scale.set(1, 0.85, 1);
    core.position.y = 0.055;
    flower.add(core);
    flower.position.set(0, BASE_Y + TRUNK_H + 0.005, 0);
    flower.rotation.z = -0.05;
    flower.rotation.z = -0.12;
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
    var MOODS = {
      idle:   { eyeY: 1, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1, mouthSY: 1, blush: 0 },
      happy:  { eyeY: 0.56, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1.2, mouthSY: 1.25, blush: 0.9 },
      smirk:  { eyeY: 0.5, brow: 0.55, browTilt: 0.5, mouthRot: Math.PI - 0.34, mouthSX: 1.05, mouthSY: 0.85, blush: 0.18 },
      angry:  { eyeY: 0.82, brow: 1, browTilt: -1, mouthRot: 0.06, mouthSX: 1.06, mouthSY: 0.9, blush: 0.42 },
      sleep:  { eyeY: 0.09, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 0.42, mouthSY: 0.55, blush: 0 },
      listen: { eyeY: 1.34, brow: 0.35, browTilt: 0.2, mouthRot: Math.PI, mouthSX: 0.62, mouthSY: 0.62, blush: 0.24 },
      /* 吃惊：眼睛瞪圆、眉毛挑高、嘴缩成一个小圆 */
      surprised: { eyeY: 1.32, brow: 1, browTilt: 0.1, mouthRot: Math.PI, mouthSX: 0.46, mouthSY: 1.45, blush: 0.3 },
      /* 委屈/蔫了：眼睛下垂、眉毛八字、嘴往下撇 */
      sad: { eyeY: 0.72, brow: 0.6, browTilt: -0.7, mouthRot: 0.18, mouthSX: 0.9, mouthSY: 0.8, blush: 0.12 },
    };
    var cur = { eyeY: 1, brow: 0, browTilt: 0, mouthRot: Math.PI, mouthSX: 1, mouthSY: 1, blush: 0 };
    var want = MOODS.idle;
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

      /* 眨眼 */
      blinkNext -= dt;
      if (blinkNext <= 0) { blink = 1; blinkNext = 2.6 + Math.random() * 4.2; }
      if (blink > 0) blink = Math.max(0, blink - dt * 5.2);
      var eyeY = cur.eyeY * (1 - Math.sin(blink * Math.PI) * 0.94);

      eyeL.scale.y = eyeY; eyeR.scale.y = eyeY;
      browL.material.opacity = cur.brow; browR.material.opacity = cur.brow;
      browL.rotation.z = 0.16 + cur.browTilt * 0.42;
      browR.rotation.z = -0.16 - cur.browTilt * 0.42;
      browL.position.y = FACE_Y + 0.135 + (cur.browTilt < 0 ? -0.012 : 0.008);
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
      root.position.y = hop;
      root.rotation.x = Math.sin(t * 0.42) * 0.012;
      var breathe = 1 + Math.sin(t * 1.15) * 0.008;
      swayGroup.scale.set(1, breathe, 1);
      swayGroup.position.y = Math.sin(t * 1.15) * 0.005;
      flower.rotation.y = Math.sin(t * 0.7) * 0.25;
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
      rotDeg: function () { return rotY; },
      mood: function () { return mood; },
      isTalking: function () { return !!(talkingOn && performance.now() < talkUntil); },
      startDrag: function () { dragging = true; },
      endDrag: function () { dragging = false; },
      pause: function () { running = false; },
      resume: function () { running = true; last = performance.now(); },
      refreshTheme: function () {
        pal = palette();
        matSkin.color.copy(pal.skin);
        matSkinDeep.color.copy(pal.skinDeep);
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
