/* 合成大基娜 — 玩法与物理引擎
 * 纯原生 JS + Canvas，无任何依赖。
 */
(function () {
  'use strict';

  /* ==================== 配置 ==================== */

  // 场地：450×640，贴合手机竖屏比例
  const FIELD_W = 450;
  const FIELD_H = 640;
  // 场地上方额外留出的投放区高度（逻辑单位）。待投放的球悬在场地上边界之外，
  // 所以画布要给它留出空间，否则会被裁掉。
  const DROP_ZONE = 56;

  const LEVELS = 11;
  // 11 级半径，相邻比例约 1.14
  //
  // 关键约束：两个最高级必须碰得到。球心活动范围 [r, FIELD_W - r]，
  // 最大间距 = FIELD_W - 2r，两球相切需要 2r。
  // 必须满足 FIELD_W - 2r > 2r  →  r < FIELD_W / 4 = 112.5。
  // 现在取 98：最大间距 254 > 196，留 58px 余量。
  const RADII = [26, 30, 34, 39, 44, 50, 58, 66, 75, 86, 98];

  // 判定线：到顶格的高度 = 2 级图片的高度（2 × 30 = 60）。
  // 原来放在 118，头顶上方空出一大片，越过线也迟迟没有反馈。
  const DEATH_Y = 60;
  // 待投放物件的中心 y，必须在判定线之上
  const DROP_Y = 6;
  // 投放配置。口令正确时切到 easy 档。
  // weights 第 i 项 = 投放第 i+1 级的相对权重，数组长度就是「可投放的最高级」。
  const DROP_PROFILES = {
    normal: { name: '普通', maxLevel: 5, weights: [30, 26, 20, 14, 10], winLevel: 11, items: 0 },
    // 口令模式：通关线不变，每局给 3 个「同级合并」道具
    easy: { name: '简易', maxLevel: 5, weights: [30, 26, 20, 14, 10], winLevel: 11, items: 3 },
  };
  const EASY_CODE = '52nana1314';
  const EASY_KEY = 'jina.easy.v1';
  let dropProfile = DROP_PROFILES.normal;
  const DROP_COOLDOWN = 0.40;   // 秒
  const OVER_DELAY = 1.1;       // 越线持续多久判负
  const CHAIN_WINDOW = 0.9;     // 连击窗口
  const MAX_ANG = 0.175;        // 自转限制在 ±10° 内

  // 物理
  const GRAVITY = 2400;
  const RESTITUTION = 0.35;     // 恢复系数：0.08 像砸面团，0.25 是软糖，0.35 更弹
  // 撞击形变（squash & stretch）的弹簧参数
  const SQ_STIFF = 1200;        // 劲度：越大回弹越快
  const SQ_DAMP = 26;           // 阻尼：越小抖得越久
  const SQ_MAX = 0.34;          // 形变上限，防止压成一条线
  const SQ_IMPACT_REF = 900;    // 法向相对速度达到这个量级算「满力撞击」
  // 最小冲击阈值。静止的球每步都会被重力给一个 ~20px/s 的微小冲击，
  // 不设阈值的话形变会被这一步一踢维持住，静止的球永远保持 1~2% 的压扁。
  const SQ_MIN_IMPACT = 130;
  const SQ_GAIN = 9;

  // 由撞击速度换算形变量（0 = 不形变）
  function squashAmount(speed) {
    if (speed <= SQ_MIN_IMPACT) return 0;
    return Math.min(1, (speed - SQ_MIN_IMPACT) / (SQ_IMPACT_REF - SQ_MIN_IMPACT));
  }
  const FRICTION = 0.30;        // 切向摩擦
  const AIR_DRAG = 0.9996;
  const ANG_DRAG = 0.982;
  const SLOP = 0.06;
  const CORRECT = 0.5;
  // 恢复系数提到 0.25 之后堆叠更「活」，需要更多迭代才能收敛到无明显穿插
  const ITERATIONS = 18;
  const FIXED_DT = 1 / 120;
  const MAX_STEPS = 6;
  // 地面摩擦按「每秒衰减率」定义，不能按步累乘。
  // 位置修正要迭代 12 次，速度/摩擦只能每步施加一次，
  // 否则一帧之内就把横向速度磨光，球落地即停、完全不滚动。
  const GROUND_FRICTION = 2.0;
  const FLOOR_DAMP = Math.exp(-GROUND_FRICTION * FIXED_DT);

  // 粒子配色（9 关）
  const COLORS = [
    '#FFE9F0', '#FFDCC2', '#FFF3C4', '#DCF3C6', '#B8ECD4',
    '#B4E0F7', '#DCC6F5', '#FFC2C2', '#FFE08A',
  ];
  const RING = [
    '#F5A9C0', '#F0A882', '#E8C85E', '#A8D06A', '#6FC9A4',
    '#6CB6E0', '#B08AE0', '#F08080', '#E8B33A',
  ];

  const BEST_KEY = 'jina.best.v1';
  const SOUND_KEY = 'jina.sound.v1';

  // 单文件离线版会把精灵图以 data URI 注入到 window.__SPRITES__，
  // 有它就用它，没有就读 assets/ 目录。两套交付方式共用同一份代码。
  const SPRITE_DATA = (typeof window !== 'undefined' && window.__SPRITES__) || null;
  const spriteSrc = (level) =>
    SPRITE_DATA && SPRITE_DATA[level - 1]
      ? SPRITE_DATA[level - 1]
      : `assets/lv${String(level).padStart(2, '0')}.webp`;

  // localStorage 在 file:// 下可能被浏览器禁用并抛异常，
  // 而单文件版正是靠 file:// 打开的，所以必须兜住。
  const Store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, String(v));
      } catch (e) {
        /* 忽略：没有存档也能正常玩 */
      }
    },
  };

  /* ==================== 工具 ==================== */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // 合成出第 n 级得多少分（三角数：1,3,6,10,…,55）
  const scoreForLevel = (n) => (n * (n - 1)) / 2;

  function pickDropLevel() {
    const w = dropProfile.weights;
    let total = 0;
    for (let i = 0; i < w.length; i++) total += w[i];
    let r = Math.random() * total;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r <= 0) return i + 1;
    }
    return 1;
  }

  // 口令模式开关。返回切换后的状态。
  function setEasyMode(on) {
    dropProfile = on ? DROP_PROFILES.easy : DROP_PROFILES.normal;
    state.winLevel = dropProfile.winLevel;
    state.items = dropProfile.items; // 开启时立刻补满道具
    try {
      localStorage.setItem(EASY_KEY, on ? '1' : '0');
    } catch (e) {
      /* 无存档也能用 */
    }
    document.getElementById('app').classList.toggle('easy', on);
    elChartGrid.innerHTML = ''; // 合成表下次打开时重建
    syncItemBtn();
    return on;
  }

  function isEasyMode() {
    return dropProfile === DROP_PROFILES.easy;
  }

  /* ==================== 口令道具：同级合并 ==================== */

  // 找出场上距离最近的一对同级球（就近配对，避免球被"瞬移"太远）
  function findClosestPair() {
    const bs = state.balls;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        if (bs[i].level !== bs[j].level) continue;
        const d = Math.hypot(bs[j].x - bs[i].x, bs[j].y - bs[i].y);
        if (d < bestD) {
          bestD = d;
          best = [bs[i], bs[j]];
        }
      }
    }
    return best;
  }

  // 用掉一个道具：场上所有同级球两两合并，并且链式进行
  // （4 个 3 级 -> 2 个 4 级 -> 1 个 5 级）。返回 true 表示触发了通关。
  function useMergeItem() {
    if (state.phase !== 'play' || state.items <= 0) return false;

    const before = state.balls.length;
    let merged = 0;
    let guard = 0;

    while (guard++ < 300) {
      const pair = findClosestPair();
      if (!pair) break;
      const a = pair[0];
      const b = pair[1];

      // 两个最高级凑齐了 → 直接通关（和正常规则一致）
      if (a.level >= state.winLevel) {
        state.items--;
        syncItemBtn();
        victory(a.x, a.y, b.x, b.y);
        return true;
      }

      const nl = a.level + 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const nb = makeBall(nl, mx, my);
      nb.pop = 1;
      nb.landed = true;
      nb.touched = true;
      nb.vx = (a.vx + b.vx) * 0.3;
      nb.vy = (a.vy + b.vy) * 0.3;

      a.merged = true;
      b.merged = true;
      state.balls = state.balls.filter((x) => x !== a && x !== b);
      state.balls.push(nb);

      onMerge(nl, mx, my);
      merged++;
    }

    state.items--;
    syncItemBtn();
    Sfx.item();

    if (merged > 0) {
      // 全屏撒一把粒子，让"一次全合"有反馈
      for (let k = 0; k < 5; k++) {
        spawnParticles(rand(60, FIELD_W - 60), rand(FIELD_H * 0.35, FIELD_H - 60), 3 + (k % 4));
      }
    }
    console.log(`[道具] 场上 ${before} 个 -> ${state.balls.length} 个，共合成 ${merged} 次，剩余 ${state.items}`);
    return false;
  }

  /* ==================== 精灵图 ==================== */

  const sprites = new Array(LEVELS).fill(null);

  function loadSprites() {
    const jobs = [];
    for (let i = 1; i <= LEVELS; i++) {
      jobs.push(
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            sprites[i - 1] = img;
            resolve();
          };
          img.onerror = () => resolve(); // 单张失败不阻塞整局
          img.src = spriteSrc(i);
        })
      );
    }
    return Promise.all(jobs);
  }

  /* ==================== 音效（WebAudio 合成，无需音频文件） ==================== */

  const Sfx = {
    ac: null,
    on: Store.get(SOUND_KEY) !== '0',

    ensure() {
      if (!this.ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ac = new AC();
      }
      if (this.ac.state === 'suspended') this.ac.resume();
      return this.ac;
    },

    tone(freq, dur, type, vol, delay) {
      if (!this.on) return;
      const ac = this.ensure();
      if (!ac) return;
      const t0 = ac.currentTime + (delay || 0);
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol == null ? 0.16 : vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },

    drop() {
      this.tone(220, 0.09, 'triangle', 0.10);
    },

    // 合并音随等级升调
    merge(level) {
      const f = 300 * Math.pow(1.085, level);
      this.tone(f, 0.16, 'sine', 0.15);
      this.tone(f * 1.5, 0.12, 'sine', 0.07, 0.03);
    },

    bump() {
      this.tone(120, 0.06, 'sine', 0.05);
    },

    // 道具：上行琶音，有"发动"的感觉
    item() {
      [392, 523, 659, 880].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.13, i * 0.06));
    },

    win() {
      [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.36, 'triangle', 0.16, i * 0.12));
    },

    over() {
      [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.32, 'sine', 0.14, i * 0.14));
    },

    toggle() {
      this.on = !this.on;
      Store.set(SOUND_KEY, this.on ? '1' : '0');
      if (this.on) this.tone(660, 0.1, 'sine', 0.12);
      return this.on;
    },
  };

  /* ==================== 游戏状态 ==================== */

  const state = {
    balls: [],
    particles: [],
    score: 0,
    best: Number(Store.get(BEST_KEY) || 0),
    phase: 'idle', // idle | play | over | win
    heldLevel: 1,
    nextLevel: 1,
    aimX: FIELD_W / 2,
    cooldown: 0,
    chain: 0,
    chainTimer: 0,
    overTimer: 0,
    uid: 1,
    winAt: 0,
    // 「重来一次」用：每次投放前记录一份棋盘快照，回退两步即可消除最后两次放下的图案
    history: [],
    reviveUsed: false,
    // 通关线：两个该等级的球相撞即通关。目前普通/口令模式都是 11 级。
    winLevel: LEVELS,
    // 口令道具：剩余「同级合并」次数
    items: 0,
  };

  function makeBall(level, x, y) {
    const r = RADII[level - 1];
    const m = r * r;
    return {
      id: state.uid++,
      level, r,
      x, y, vx: 0, vy: 0,
      m, invM: 1 / m,
      ang: rand(-0.25, 0.25), angVel: 0,
      // 撞击形变：sq 为当前压扁量，sqA 为压扁轴向（世界坐标），sqV 为弹簧速度
      sq: 0, sqA: 0, sqV: 0,
      touched: false, landed: false,
      merged: false, pop: 0,
    };
  }

  function resetGame() {
    state.balls.length = 0;
    state.particles.length = 0;
    state.score = 0;
    state.phase = 'play';
    state.heldLevel = pickDropLevel();
    state.nextLevel = pickDropLevel();
    state.aimX = FIELD_W / 2;
    state.cooldown = 0;
    state.chain = 0;
    state.chainTimer = 0;
    state.overTimer = 0;
    state.uid = 1;
    state.winAt = 0;
    state.history.length = 0;
    state.reviveUsed = false;
    state.winLevel = dropProfile.winLevel;
    state.items = dropProfile.items; // 每局重新补满道具
    syncHud();
    syncItemBtn();
  }

  // 投放前记录棋盘快照（浅拷贝足够，球的字段都是基本类型）
  function pushHistory() {
    state.history.push({
      balls: state.balls.map((b) => Object.assign({}, b)),
      score: state.score,
    });
    if (state.history.length > 8) state.history.shift();
  }

  // 「重来一次」：回退到最后两次投放之前，等于消除最后两次放下的图案
  function revive() {
    const h = state.history;
    if (h.length >= 2) {
      const snap = h[h.length - 2];
      state.balls = snap.balls.map((b) => Object.assign({}, b));
      state.score = snap.score;
      h.length = h.length - 2;
    } else {
      state.balls = [];
      state.score = 0;
      h.length = 0;
    }
    state.phase = 'play';
    state.overTimer = 0;
    state.chain = 0;
    state.chainTimer = 0;
    state.cooldown = 0.5; // 给一点缓冲，避免刚落子就又被判负
    state.reviveUsed = true;
    state.particles.length = 0;
    hideOverlay();
    syncHud();
  }

  /* ==================== 物理 ==================== */

  function integrate(dt) {
    const balls = state.balls;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.merged) continue;

      b.vy += GRAVITY * dt;
      b.vx *= AIR_DRAG;
      b.vy *= AIR_DRAG;

      // 慢速时额外阻尼，避免堆叠抖动
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 5) {
        b.vx *= 0.85;
        b.vy *= 0.85;
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      // 自转：限制在 ±MAX_ANG 内来回摆，不让人形转得底朝天
      b.ang += b.angVel * dt;
      if (b.ang > MAX_ANG) {
        b.ang = MAX_ANG;
        b.angVel = -Math.abs(b.angVel) * 0.4;
      } else if (b.ang < -MAX_ANG) {
        b.ang = -MAX_ANG;
        b.angVel = Math.abs(b.angVel) * 0.4;
      }
      b.angVel *= ANG_DRAG;

      // 形变的弹簧回弹
      b.sqV += (-SQ_STIFF * b.sq - SQ_DAMP * b.sqV) * dt;
      b.sq += b.sqV * dt;
      if (b.sq > SQ_MAX) { b.sq = SQ_MAX; b.sqV = 0; }
      else if (b.sq < -SQ_MAX * 0.5) { b.sq = -SQ_MAX * 0.5; b.sqV = 0; }
      // 死区：静止的球每步都会被重力/求解器给一点点微小冲击，
      // 不掐掉的话精灵会一直以极小的幅度抖动
      else if (Math.abs(b.sq) < 0.004 && Math.abs(b.sqV) < 0.06) { b.sq = 0; b.sqV = 0; }

      if (b.pop > 0) b.pop = Math.max(0, b.pop - dt / 0.26);
    }
  }

  // 沿法线方向给球一次形变冲击：法线方向压扁、垂直方向拉长（体积大致守恒）
  function squashKick(b, nx, ny, strength) {
    if (strength <= 0.0001) return;
    b.sqA = Math.atan2(ny, nx);
    b.sqV += strength;
  }

  // impulse=true 时才改变速度；其余迭代只做位置修正
  function solveWalls(b, impulse) {
    if (b.x - b.r < 0) {
      b.x = b.r;
      if (impulse) {
        if (b.vx < 0) {
          squashKick(b, 1, 0, squashAmount(-b.vx) * SQ_GAIN);
          b.vx = -b.vx * RESTITUTION;
        }
        b.vy *= Math.exp(-1.2 * FIXED_DT);
      }
      b.touched = true;
    } else if (b.x + b.r > FIELD_W) {
      b.x = FIELD_W - b.r;
      if (impulse) {
        if (b.vx > 0) {
          squashKick(b, 1, 0, squashAmount(b.vx) * SQ_GAIN);
          b.vx = -b.vx * RESTITUTION;
        }
        b.vy *= Math.exp(-1.2 * FIXED_DT);
      }
      b.touched = true;
    }

    if (b.y + b.r > FIELD_H) {
      b.y = FIELD_H - b.r;
      if (impulse) {
        if (b.vy > 0) {
          squashKick(b, 0, 1, squashAmount(b.vy) * SQ_GAIN);
          b.vy = -b.vy * RESTITUTION;
        }
        b.angVel += b.vx * 0.0022;
      }
      b.vx *= FLOOR_DAMP;
      b.touched = true;
    }
  }

  function solvePair(a, b, impulse) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const rr = a.r + b.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return;

    const d = Math.sqrt(d2) || 0.0001;
    const nx = d > 0.0001 ? dx / d : 0;
    const ny = d > 0.0001 ? dy / d : -1;

    a.touched = true;
    b.touched = true;

    const invSum = a.invM + b.invM;

    // 位置修正（多次迭代收敛，避免穿透）
    const overlap = rr - d;
    if (overlap > SLOP) {
      const corr = ((overlap - SLOP) / invSum) * CORRECT;
      a.x -= nx * corr * a.invM;
      a.y -= ny * corr * a.invM;
      b.x += nx * corr * b.invM;
      b.y += ny * corr * b.invM;
    }

    if (!impulse) return;

    // 速度冲量
    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      // 撞击强度 + 按质量分配形变：速度变化正比于 invM，
      // 所以轻的一方形变更大 —— 这就是「按惯性判断」的体现
      const impact = squashAmount(-vn);
      squashKick(a, -nx, -ny, impact * SQ_GAIN * (a.invM / invSum) * 2);
      squashKick(b, nx, ny, impact * SQ_GAIN * (b.invM / invSum) * 2);

      const jn = (-(1 + RESTITUTION) * vn) / invSum;
      a.vx -= nx * jn * a.invM;
      a.vy -= ny * jn * a.invM;
      b.vx += nx * jn * b.invM;
      b.vy += ny * jn * b.invM;

      // 切向摩擦 + 视觉自转
      const tx = -ny;
      const ty = nx;
      const vt = rvx * tx + rvy * ty;
      const jt = (-vt * FRICTION) / invSum;
      a.vx -= tx * jt * a.invM;
      a.vy -= ty * jt * a.invM;
      b.vx += tx * jt * b.invM;
      b.vy += ty * jt * b.invM;

      const spin = vt * 0.0007;
      a.angVel -= spin;
      b.angVel += spin;
    }
  }

  function physicsStep(dt) {
    const balls = state.balls;
    integrate(dt);

    // 合并判定必须在位置修正之前：求解器会把重叠的同级球推开，
    // 等修正完再判定的话，该合成的球会因为已经被分离而永远合不了。
    // 用积分后的位置判定，此时接触/重叠状态还是真实的。
    if (resolveMerges()) return true;

    for (let it = 0; it < ITERATIONS; it++) {
      const impulse = it === 0; // 速度响应每步只做一次
      for (let i = 0; i < balls.length; i++) {
        if (!balls[i].merged) solveWalls(balls[i], impulse);
      }
      for (let i = 0; i < balls.length; i++) {
        const a = balls[i];
        if (a.merged) continue;
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j];
          if (b.merged) continue;
          solvePair(a, b, impulse);
        }
      }
    }

    // 硬性边界钳制：迭代解法在极端堆叠（球体总截面远大于场地）时仍可能把球挤出去，
    // 这里兜一道底，保证任何情况下球都不会离开场地。
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.merged) continue;
      b.x = clamp(b.x, b.r, FIELD_W - b.r);
      if (b.y + b.r > FIELD_H) b.y = FIELD_H - b.r;
    }

    // 落地标记
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (!b.landed && b.touched) b.landed = true;
    }
    return false;
  }

  /* ==================== 合成 ==================== */

  function resolveMerges() {
    const balls = state.balls;

    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.merged) continue;
      // a 可能已被本轮更早的合并标记掉
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.merged || a.merged) continue;
        if (a.level !== b.level) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        // 相切即算合并（+0.5 容差）。位置修正会把静止的球推到只留 SLOP 的微小重叠，
        // 若要求「明显重叠」才合并，会出现两个同级球贴在一起却永远不合成的情况。
        if (Math.hypot(dx, dy) > a.r + b.r + 0.5) continue;

        // 两个最高级相撞 → 通关（简易模式通关线会调低）
        if (a.level >= state.winLevel) {
          victory(a.x, a.y, b.x, b.y);
          return true;
        }

        a.merged = true;
        b.merged = true;

        const nl = a.level + 1;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const nb = makeBall(nl, mx, my);
        nb.vx = (a.vx + b.vx) * 0.35;
        nb.vy = (a.vy + b.vy) * 0.35;
        nb.angVel = (a.angVel + b.angVel) * 0.5;
        nb.pop = 1;
        nb.landed = true;
        nb.touched = true;
        balls.push(nb);

        onMerge(nl, mx, my);
      }
    }

    if (balls.some((b) => b.merged)) {
      state.balls = balls.filter((b) => !b.merged);
    }
    return false;
  }

  function onMerge(level, x, y) {
    // 连击
    state.chain = state.chainTimer > 0 ? state.chain + 1 : 1;
    state.chainTimer = CHAIN_WINDOW;

    const base = scoreForLevel(level);
    // 连击加成封顶 3 倍。道具一次触发几十次合成，不封顶会瞬间刷出天价分数。
    const mult = 1 + Math.min(state.chain - 1, 4) * 0.5;
    const gain = Math.round(base * mult);
    state.score += gain;

    spawnParticles(x, y, level);
    Sfx.merge(level);

    if (state.chain >= 2) showCombo(state.chain);
    syncHud();
  }

  function spawnParticles(x, y, level) {
    const n = 8 + Math.min(level, 8);
    const color = RING[level - 1];
    const light = COLORS[level - 1];
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(60, 250) * (0.6 + level * 0.06);
      state.particles.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 60,
        life: 1,
        decay: rand(1.5, 2.8),
        r: rand(2.5, 3 + level * 0.7),
        color: i % 3 === 0 ? light : color,
      });
    }
  }

  function stepParticles(dt) {
    const ps = state.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.vy += 1500 * dt;
      p.vx *= 0.98;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) ps.splice(i, 1);
    }
  }

  /* ==================== 胜负 ==================== */

  function checkOverflow(dt) {
    if (state.phase !== 'play') return;
    let over = false;
    for (let i = 0; i < state.balls.length; i++) {
      const b = state.balls[i];
      // landed 已经能排除「正在下落 / 刚投出」的球，不需要再卡速度阈值。
      // 之前那个「速度 < 70px/s 才算危险」的条件，会让还在轻微晃动的堆顶球
      // 永远不满足危险判定，于是越线了也迟迟不判负 —— 这就是「超过虚线没反应」的原因。
      if (b.landed && b.y - b.r < DEATH_Y) {
        over = true;
        break;
      }
    }
    if (over) {
      state.overTimer += dt;
      if (state.overTimer >= OVER_DELAY) gameOver();
    } else {
      // 用衰减而不是直接清零：否则堆顶球抖一下就把计时器抹掉，永远攒不满
      state.overTimer = Math.max(0, state.overTimer - dt * 1.5);
    }
  }

  function saveBest() {
    if (state.score > state.best) {
      state.best = state.score;
      Store.set(BEST_KEY, state.best);
    }
  }

  function gameOver() {
    state.phase = 'over';
    saveBest();
    Sfx.over();
    syncHud();
    // 只有本局还没用过、且确实有可回退的投放记录时，才给「重来一次」
    const canRevive = !state.reviveUsed && state.history.length > 0;
    showOverlay('游戏结束', '重新开始', true, false, canRevive);
  }

  function victory(ax, ay, bx, by) {
    state.phase = 'win';
    saveBest();
    Sfx.win();
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    for (let k = 0; k < 6; k++) {
      setTimeout(() => spawnParticles(mx + rand(-40, 40), my + rand(-40, 40), LEVELS), k * 90);
    }
    syncHud();
    showOverlay('恭喜通关！', '再来一局', false, true, false);
  }

  /* ==================== 投放 ==================== */

  function drop() {
    if (state.phase !== 'play' || state.cooldown > 0) return;

    const level = state.heldLevel;
    const r = RADII[level - 1];
    const x = clamp(state.aimX, r, FIELD_W - r);

    pushHistory(); // 落子前先存快照，供「重来一次」回退

    const b = makeBall(level, x, DROP_Y);
    b.vy = 60;
    state.balls.push(b);

    state.heldLevel = state.nextLevel;
    state.nextLevel = pickDropLevel();
    state.cooldown = DROP_COOLDOWN;
    state.chainTimer = 0;

    Sfx.drop();
    syncHud();
  }

  // 预测落点：沿当前 x 找第一个会碰上的球
  function predictLanding(x, r) {
    let best = FIELD_H - r;
    for (let i = 0; i < state.balls.length; i++) {
      const b = state.balls[i];
      const dx = Math.abs(x - b.x);
      const rr = r + b.r;
      if (dx >= rr) continue;
      const dy = Math.sqrt(rr * rr - dx * dx);
      const yTop = b.y - dy;
      if (yTop < best) best = yTop;
    }
    return best;
  }

  /* ==================== 渲染 ==================== */

  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const stage = document.getElementById('stage');

  const view = { w: 0, h: 0, dpr: 1, scale: 1, ox: 0, oy: 0 };

  function resize() {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.w = Math.max(1, rect.width);
    view.h = Math.max(1, rect.height);
    view.dpr = dpr;
    cv.width = Math.round(view.w * dpr);
    cv.height = Math.round(view.h * dpr);
    // 画布总高 = 投放区 + 场地。待投放的球悬在场地上边界之外，必须给它留位置。
    const totalH = FIELD_H + DROP_ZONE;
    view.scale = Math.min(view.w / FIELD_W, view.h / totalH);
    view.ox = (view.w - FIELD_W * view.scale) / 2;
    // 场地上边界 (0,0) 在投放区下方
    view.oy = (view.h - totalH * view.scale) / 2 + DROP_ZONE * view.scale;
  }

  function render() {
    const { w, h, dpr, scale, ox, oy } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);

    drawField();
    drawAim();

    for (let i = 0; i < state.balls.length; i++) drawBall(state.balls[i]);

    drawHeld();
    drawParticles();

    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawField() {
    roundRect(0, 0, FIELD_W, FIELD_H, 18);
    const g = ctx.createLinearGradient(0, 0, 0, FIELD_H);
    g.addColorStop(0, '#fffdfe');
    g.addColorStop(1, '#fff4f8');
    ctx.fillStyle = g;
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffe0ec';
    ctx.stroke();

    // 危险度 0~1：越线持续的时间占判负阈值的比例
    const danger = clamp(state.overTimer / OVER_DELAY, 0, 1);

    if (danger > 0) {
      // 顶部红色警示带，越接近判负越浓
      ctx.save();
      roundRect(0, 0, FIELD_W, FIELD_H, 18);
      ctx.clip();
      const dg = ctx.createLinearGradient(0, 0, 0, DEATH_Y + 46);
      dg.addColorStop(0, `rgba(255,86,120,${(0.10 + 0.30 * danger).toFixed(3)})`);
      dg.addColorStop(1, 'rgba(255,86,120,0)');
      ctx.fillStyle = dg;
      ctx.fillRect(0, 0, FIELD_W, DEATH_Y + 46);
      ctx.restore();
    }

    // 判定线
    ctx.save();
    ctx.setLineDash([9, 9]);
    ctx.lineWidth = danger > 0 ? 3.5 : 2;
    ctx.strokeStyle = danger > 0 ? `rgba(240,74,112,${(0.55 + 0.45 * danger).toFixed(3)})` : 'rgba(240,150,175,0.55)';
    ctx.beginPath();
    ctx.moveTo(10, DEATH_Y);
    ctx.lineTo(FIELD_W - 10, DEATH_Y);
    ctx.stroke();
    ctx.restore();

    // 明确的「危险」提示，避免玩家不知道已经越线
    if (danger > 0.12) {
      ctx.save();
      ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(state.overTimer * 7));
      ctx.font = 'bold 21px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e8446a';
      ctx.fillText('危 险', FIELD_W / 2, DEATH_Y + 26);
      ctx.restore();
    }
  }

  function drawAim() {
    if (state.phase !== 'play') return;
    const level = state.heldLevel;
    const r = RADII[level - 1];
    const x = clamp(state.aimX, r, FIELD_W - r);
    const yLand = predictLanding(x, r);

    ctx.save();
    ctx.setLineDash([7, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(242,120,159,0.4)';
    ctx.beginPath();
    ctx.moveTo(x, DROP_Y);
    ctx.lineTo(x, yLand + r);
    ctx.stroke();
    ctx.restore();

    // 落点虚影
    const img = sprites[level - 1];
    if (img) {
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.drawImage(img, x - r, yLand - r, r * 2, r * 2);
      ctx.restore();
    }
  }

  function drawBall(b) {
    const img = sprites[b.level - 1];
    if (!img) return;

    ctx.save();
    ctx.translate(b.x, b.y);

    // 形变：沿撞击法线压扁、垂直方向拉长（在世界坐标下做，不受自转影响）
    if (Math.abs(b.sq) > 0.003) {
      ctx.rotate(b.sqA);
      ctx.scale(1 - b.sq, 1 + b.sq);
      ctx.rotate(-b.sqA);
    }

    // 自转（已限制在 ±10° 内，只会轻微摇摆）
    if (b.ang) ctx.rotate(b.ang);

    // 合成瞬间的弹一下
    if (b.pop > 0) {
      const s = 1 + 0.24 * Math.sin(b.pop * Math.PI);
      ctx.scale(s, s);
    }

    ctx.drawImage(img, -b.r, -b.r, b.r * 2, b.r * 2);
    ctx.restore();
  }

  function drawHeld() {
    if (state.phase !== 'play') return;
    const level = state.heldLevel;
    const r = RADII[level - 1];
    const x = clamp(state.aimX, r, FIELD_W - r);
    const img = sprites[level - 1];
    if (!img) return;

    ctx.save();
    ctx.globalAlpha = state.cooldown > 0 ? 0.35 : 1;
    ctx.drawImage(img, x - r, DROP_Y - r, r * 2, r * 2);
    ctx.restore();
  }

  function drawParticles() {
    const ps = state.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ==================== 主循环 ==================== */

  let last = 0;
  let acc = 0;

  // 一帧的逻辑推进。抽成独立函数是为了能被测试直接驱动 ——
  // 之前主循环的逻辑完全没被测到，「越线不判负」这个 bug 才漏了出去。
  function update(dt) {
    if (state.phase === 'play') {
      if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
      if (state.chainTimer > 0) {
        state.chainTimer -= dt;
        if (state.chainTimer <= 0) state.chain = 0;
      }

      acc += dt;
      let steps = 0;
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        const won = physicsStep(FIXED_DT);
        acc -= FIXED_DT;
        steps++;
        if (won) break;
      }
      if (steps >= MAX_STEPS) acc = 0;

      checkOverflow(dt);
    } else {
      acc = 0;
    }

    stepParticles(dt);
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.1) dt = 0.1; // 切回标签页时不要一次性补太多
    update(dt);
    render();
  }

  /* ==================== UI ==================== */

  const elScore = document.getElementById('score');
  const elBest = document.getElementById('best');
  const elNext = document.getElementById('nextImg');
  const elOverlay = document.getElementById('overlay');
  const elOvTitle = document.getElementById('ovTitle');
  const elOvSub = document.getElementById('ovSub');
  const elOvBtn = document.getElementById('ovBtn');
  const elOvScoreWrap = document.getElementById('ovScoreWrap');
  const elOvScore = document.getElementById('ovScore');
  const elOvBest = document.getElementById('ovBest');
  const elCombo = document.getElementById('combo');
  const elChart = document.getElementById('chartModal');
  const elChartGrid = document.getElementById('chartGrid');
  const elCodeInput = document.getElementById('codeInput');
  const elCodeBtn = document.getElementById('codeBtn');
  const elCodeMsg = document.getElementById('codeMsg');
  const elWinHint = document.getElementById('winHint');
  const elItemBtn = document.getElementById('itemBtn');
  const elItemCount = document.getElementById('itemCount');

  // 道具按钮：只在口令模式下显示，用完变灰
  function syncItemBtn() {
    if (!elItemBtn) return;
    const on = isEasyMode();
    elItemBtn.hidden = !on;
    if (!on) return;
    elItemCount.textContent = state.items;
    elItemBtn.classList.toggle('empty', state.items <= 0);
  }
  const elOvRevive = document.getElementById('ovRevive');
  const btnSound = document.getElementById('btnSound');

  function syncHud() {
    elScore.textContent = state.score;
    elBest.textContent = state.best;
    if (sprites[state.nextLevel - 1]) {
      elNext.src = sprites[state.nextLevel - 1].src;
    }
  }

  let comboTimer = null;
  function showCombo(n) {
    elCombo.textContent = `连击 x${n}`;
    elCombo.classList.add('pop');
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => elCombo.classList.remove('pop'), 520);
  }

  function showOverlay(title, btnText, withScore, isWin, canRevive) {
    elOvTitle.textContent = title;
    elOvSub.textContent = isWin
      ? `两个 ${state.winLevel} 级撞在一起了！`
      : withScore
        ? '别灰心，再来一次'
        : '相同的撞在一起，越合越大';
    elOvBtn.textContent = btnText;
    elOvScoreWrap.hidden = !withScore && !isWin;
    elOvScore.textContent = state.score;
    elOvBest.textContent = state.best;
    elOvRevive.hidden = !canRevive;
    elOverlay.classList.add('show');
  }

  function hideOverlay() {
    elOverlay.classList.remove('show');
  }

  function buildChart() {
    if (elChartGrid.childElementCount) return;
    let html = '';
    for (let i = 1; i <= state.winLevel; i++) {
      const pts = i >= 2 ? `<div class="pt">${scoreForLevel(i)} 分</div>` : `<div class="pt">&nbsp;</div>`;
      html +=
        `<div class="chartItem${i === LEVELS ? ' top' : ''}">` +
        `<img src="${spriteSrc(i)}" alt="">` +
        `<div class="lv">${i} 级</div>${pts}</div>`;
    }
    elChartGrid.innerHTML = html;
  }

  /* ==================== 输入 ==================== */

  function pointerToFieldX(clientX) {
    const rect = cv.getBoundingClientRect();
    return (clientX - rect.left - view.ox) / view.scale;
  }

  let dragging = false;

  function onPointerDown(e) {
    if (state.phase !== 'play') return;
    dragging = true;
    state.aimX = pointerToFieldX(e.clientX);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (state.phase !== 'play') return;
    // 鼠标悬停也能瞄准；触屏只有按下后才跟随
    if (e.pointerType === 'mouse' || dragging) {
      state.aimX = pointerToFieldX(e.clientX);
    }
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (state.phase !== 'play') return;
    if (dragging || e.pointerType === 'mouse') {
      state.aimX = pointerToFieldX(e.clientX);
      dragging = false;
      drop();
    }
    e.preventDefault();
  }

  cv.addEventListener('pointerdown', onPointerDown, { passive: false });
  cv.addEventListener('pointermove', onPointerMove, { passive: false });
  cv.addEventListener('pointerup', onPointerUp, { passive: false });
  cv.addEventListener('pointercancel', () => (dragging = false));
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.shiftKey ? 24 : 10;
      state.aimX = clamp(state.aimX + (e.key === 'ArrowLeft' ? -step : step), 0, FIELD_W);
      e.preventDefault();
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      drop();
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      restart();
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  /* ==================== 按钮 ==================== */

  function restart() {
    hideOverlay();
    elCombo.classList.remove('pop');
    resetGame();
  }

  elOvBtn.addEventListener('click', () => {
    Sfx.ensure(); // 首次交互解锁音频
    restart();
  });

  // 重来一次：消除最后两次放下的图案，本局只能用一次
  elOvRevive.addEventListener('click', () => {
    Sfx.ensure();
    Sfx.tone(520, 0.18, 'triangle', 0.15);
    revive();
  });

  // 口令道具：同级全合
  elItemBtn.addEventListener('click', () => {
    Sfx.ensure();
    if (state.items <= 0) return;
    useMergeItem();
  });

  document.getElementById('btnRestart').addEventListener('click', restart);

  document.getElementById('btnChart').addEventListener('click', () => {
    buildChart();
    updateWinHint();
    elChart.classList.add('show');
  });

  /* ---------- 口令 ---------- */
  function updateWinHint() {
    elWinHint.innerHTML =
      `两个 <b>${state.winLevel} 级</b>撞在一起即通关` +
      (isEasyMode() ? `　已开启简易模式` : '');
  }

  function submitCode() {
    const v = (elCodeInput.value || '').trim().toLowerCase();
    if (!v) return;
    if (v === EASY_CODE) {
      // 再输一次可以关掉
      const on = !isEasyMode();
      setEasyMode(on);
      elCodeMsg.className = 'hint ok';
      elCodeMsg.textContent = on
        ? `已开启口令模式：每局 3 个「同级全合」道具，右下角按钮使用`
        : '已关闭口令模式';
      elCodeInput.value = '';
      updateWinHint();
    } else {
      elCodeMsg.className = 'hint err';
      elCodeMsg.textContent = '口令不对';
    }
  }

  elCodeBtn.addEventListener('click', submitCode);
  elCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submitCode();
      e.preventDefault();
    }
  });

  document.getElementById('chartClose').addEventListener('click', () => elChart.classList.remove('show'));
  elChart.addEventListener('click', (e) => {
    if (e.target === elChart) elChart.classList.remove('show');
  });

  btnSound.addEventListener('click', () => {
    const on = Sfx.toggle();
    btnSound.textContent = on ? '音效开' : '音效关';
    btnSound.classList.toggle('off', !on);
  });

  /* ==================== 启动 ==================== */

  function boot() {
    resize();
    btnSound.textContent = Sfx.on ? '音效开' : '音效关';
    btnSound.classList.toggle('off', !Sfx.on);

    // 恢复上次的口令模式
    if (Store.get(EASY_KEY) === '1') {
      dropProfile = DROP_PROFILES.easy;
      state.winLevel = dropProfile.winLevel;
      state.items = dropProfile.items;
      document.getElementById('app').classList.add('easy');
    }
    updateWinHint();
    syncItemBtn();

    loadSprites().then(() => {
      syncHud();
      state.heldLevel = pickDropLevel();
      state.nextLevel = pickDropLevel();
      syncHud();
      requestAnimationFrame(loop);
    });

    document.getElementById('ovBtn').textContent = '开始游戏';
  }

  /* ==================== 无头测试钩子 ==================== */
  // 仅在 window.__JINA_TEST__ 为真时暴露内部状态，正式运行时完全不生效。
  if (window.__JINA_TEST__) {
    window.__JINA__ = {
      state, RADII, FIELD_W, FIELD_H, LEVELS, DROP_Y, DEATH_Y, FIXED_DT,
      RESTITUTION, MAX_ANG, SQ_MAX, OVER_DELAY, DEATH_Y,
      resetGame, makeBall, physicsStep, resolveMerges, predictLanding, scoreForLevel, checkOverflow,
      // 渲染与主循环逻辑也要能被测到（否则绘制代码和循环逻辑写错测试发现不了）
      render, resize, drop, update, revive, pushHistory,
      // 口令模式
      setEasyMode, isEasyMode, EASY_CODE, getProfile: () => dropProfile, DROP_PROFILES, pickDropLevel,
      // 口令道具
      useMergeItem, findClosestPair,
      setAim(x) { state.aimX = x; },
      forceLevel(l) { state.heldLevel = l; state.cooldown = 0; },
      dropNow() { drop(); },
      tick(dt) { physicsStep(dt); },
      stepN(n, dt) { for (let i = 0; i < n; i++) { physicsStep(dt || FIXED_DT); if (resolveMerges()) break; } },
      particles: () => state.particles,
    };
  }

  boot();
})();



