/* ============================================================
   fnMonitor 设计 demo 共享模拟数据引擎
   - 字段结构对齐 app/server.py 的 /api/overview 等接口
   - 每 2 秒推进一次实时快照（平滑噪声 + 偶发尖峰），所有方案看到的是同一台"机器"
   - 纯原生 JS，无依赖
   ============================================================ */
(function () {
  'use strict';

  // ---------- 可复现随机 ----------
  let seed = 20261013;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 平滑随机游走：均值回归 + 噪声
  function walker(mean, vol, min, max, revert = 0.08) {
    let v = mean;
    return () => (v = clamp(v + (mean - v) * revert + (rand() - 0.5) * vol, min, max));
  }

  const GiB = 1024 ** 3, TiB = 1024 ** 4, MiB = 1024 ** 2;
  const bootAt = Date.now() / 1000 - (23 * 86400 + 7 * 3600 + 42 * 60);

  // ---------- 静态硬件 ----------
  const system = {
    hostname: 'fnOS-Home',
    os_pretty: 'fnOS 0.9.27 (Debian 12)',
    kernel: '6.12.18-trim',
    arch: 'x86_64',
    model: 'Intel Core i3-N305',
    board: 'CWWK CW-N305-NAS',
    ips: [
      { name: 'enp1s0', ipv4: ['192.168.1.20'], ipv6: ['fd00::20'], speed: 2500 },
      { name: 'enp2s0', ipv4: ['10.0.0.2'], ipv6: [], speed: 2500 },
    ],
  };

  const cpuCores = 8;
  const disksDef = [
    { name: 'nvme0n1', vendor: 'Samsung', model: '990 PRO 1TB', type: 'nvme', size: 1 * 1000 ** 4, used: 0.31 * 1000 ** 4, mounts: ['/', '/vol1'], serial: 'S6Z1NJ0W412345', power_on_hours: 8123, health: 'PASSED', baseTemp: 41 },
    { name: 'sda', vendor: 'WDC', model: 'WD Red Plus 8TB', type: 'hdd', size: 8 * 1000 ** 4, used: 5.62 * 1000 ** 4, mounts: ['/vol2'], serial: 'WD-CA1Q2W3E', power_on_hours: 21540, health: 'PASSED', baseTemp: 36 },
    { name: 'sdb', vendor: 'WDC', model: 'WD Red Plus 8TB', type: 'hdd', size: 8 * 1000 ** 4, used: 5.62 * 1000 ** 4, mounts: ['/vol2'], serial: 'WD-CA4R5T6Y', power_on_hours: 21538, health: 'PASSED', baseTemp: 37 },
    { name: 'sdc', vendor: 'Seagate', model: 'IronWolf 12TB', type: 'hdd', size: 12 * 1000 ** 4, used: 9.8 * 1000 ** 4, mounts: ['/vol3'], serial: 'ZL2ABCD1', power_on_hours: 30211, health: 'PASSED', baseTemp: 39, reallocated_sectors: 8, pending_sectors: 0 },
    { name: 'sdd', vendor: 'Toshiba', model: 'MG08 16TB', type: 'hdd', size: 16 * 1000 ** 4, used: 4.1 * 1000 ** 4, mounts: ['/vol4'], serial: '51X0A0ABFVGG', power_on_hours: 4312, health: 'PASSED', baseTemp: 34, standby: true },
  ];

  const containersDef = [
    { name: 'jellyfin', image: 'jellyfin/jellyfin:10.10', ports: '8096→8096', cpu: 6, mem: 820 * MiB, state: 'running', up: 9 * 86400 },
    { name: 'immich-server', image: 'ghcr.io/immich-app/immich-server:v1.131', ports: '2283→2283', cpu: 3, mem: 1.4 * GiB, state: 'running', up: 9 * 86400 },
    { name: 'immich-postgres', image: 'tensorchord/pgvecto-rs:pg16', ports: '', cpu: 1, mem: 380 * MiB, state: 'running', up: 9 * 86400 },
    { name: 'qbittorrent', image: 'linuxserver/qbittorrent:5.0', ports: '8080→8080, 6881', cpu: 4, mem: 610 * MiB, state: 'running', up: 3 * 86400 },
    { name: 'homeassistant', image: 'homeassistant/home-assistant:2026.10', ports: '8123→8123', cpu: 2, mem: 540 * MiB, state: 'running', up: 23 * 86400 },
    { name: 'nginx-proxy-manager', image: 'jc21/nginx-proxy-manager:2', ports: '80, 443, 81', cpu: 0.4, mem: 120 * MiB, state: 'running', up: 23 * 86400 },
    { name: 'vaultwarden', image: 'vaultwarden/server:1.33', ports: '8000→80', cpu: 0.1, mem: 34 * MiB, state: 'running', up: 23 * 86400 },
    { name: 'alist', image: 'xhofe/alist:v3.42', ports: '5244→5244', cpu: 0.3, mem: 88 * MiB, state: 'running', up: 12 * 86400 },
    { name: 'transmission', image: 'linuxserver/transmission:4.0', ports: '9091→9091', cpu: 0, mem: 0, state: 'exited', up: 0 },
    { name: 'portainer', image: 'portainer/portainer-ce:2.21', ports: '9000→9000', cpu: 0, mem: 0, state: 'exited', up: 0 },
  ];

  const procDef = [
    ['jellyfin', 'root', '/usr/lib/jellyfin/bin/jellyfin --ffmpeg /usr/lib/jellyfin-ffmpeg/ffmpeg'],
    ['ffmpeg', 'root', '-hwaccel qsv -i /vol2/media/movies/Dune.Part.Two.2024.mkv'],
    ['immich', 'root', 'node /usr/src/app/dist/main'],
    ['qbittorrent-nox', '1000', '--webui-port=8080'],
    ['postgres', '999', 'postgres: immich immich 172.18.0.4 idle'],
    ['python3', 'root', '/var/apps/fnmonitor/target/server.py'],
    ['dockerd', 'root', '-H fd:// --containerd=/run/containerd/containerd.sock'],
    ['smbd', 'root', '/usr/sbin/smbd --foreground --no-process-group'],
    ['trim_sac', 'root', '/usr/trim/bin/trim_sac'],
    ['hass', 'root', 'python3 -m homeassistant --config /config'],
    ['nginx', 'root', 'nginx: worker process'],
    ['containerd', 'root', '/usr/bin/containerd'],
  ];

  // ---------- 实时状态 ----------
  const W = {
    cpu: walker(18, 9, 2, 96),
    mem: walker(46, 0.8, 30, 90, 0.02),
    rx: walker(14 * MiB, 9 * MiB, 0.05 * MiB, 112 * MiB, 0.12),
    tx: walker(3 * MiB, 3 * MiB, 0.02 * MiB, 60 * MiB, 0.12),
    temp: walker(52, 1.6, 38, 92, 0.06),
    mb: walker(41, 0.5, 30, 70, 0.05),
    fan: walker(1380, 60, 700, 2600, 0.08),
    rd: walker(22 * MiB, 18 * MiB, 0, 480 * MiB, 0.15),
    wr: walker(6 * MiB, 7 * MiB, 0, 380 * MiB, 0.15),
    gpu: walker(22, 7, 0, 100, 0.1),
  };
  const coreW = Array.from({ length: cpuCores }, (_, i) => walker(14 + (i % 3) * 6, 14, 0, 100, 0.15));
  const ctrW = containersDef.map(c => walker(c.cpu, Math.max(0.2, c.cpu * 0.6), 0, 100, 0.2));

  let snap = null;
  let tick = 0;
  const listeners = new Set();

  function step() {
    tick++;
    const t = Date.now() / 1000;
    let cpuPct = W.cpu();
    // 每 ~40 秒一次转码尖峰
    if (tick % 20 > 16) cpuPct = clamp(cpuPct + 38 + rand() * 18, 0, 99);
    const per_core = coreW.map(w => clamp(w() * 0.6 + cpuPct * 0.5 + (rand() - 0.5) * 8, 0, 100));
    const memTotal = 32 * GiB;
    const memPct = W.mem();
    const memUsed = memTotal * memPct / 100;
    const cpuT = W.temp() + cpuPct * 0.12;
    const rxR = W.rx(), txR = W.tx();
    const rdR = W.rd(), wrR = W.wr();
    const pkg = 6 + cpuPct * 0.24;

    const disks_detail = disksDef.map(d => ({
      name: d.name, vendor: d.vendor, model: d.model, serial: d.serial, type: d.type,
      size: d.size, used: d.used, percent: d.used / d.size * 100, mounts: d.mounts,
      temp: d.baseTemp + (d.standby ? 0 : (rand() - 0.5) * 0.6 + cpuPct * 0.02),
      health: d.health, standby: !!d.standby, power_on_hours: d.power_on_hours + Math.floor((t - bootAt) / 3600),
      reallocated_sectors: d.reallocated_sectors || 0, pending_sectors: d.pending_sectors || 0, uncorrectable: 0, udma_crc: 0,
    }));
    const activeDisks = disksDef.filter(d => !d.standby);
    const diskio = activeDisks.map((d, i) => ({
      name: d.name,
      read_rate: d.type === 'nvme' ? rdR * 0.55 : rdR * 0.45 / 3 * (0.6 + rand() * 0.8),
      write_rate: d.type === 'nvme' ? wrR * 0.7 : wrR * 0.3 / 3 * (0.6 + rand() * 0.8),
    }));
    const poolUsed = disksDef.reduce((s, d) => s + d.used, 0), poolSize = disksDef.reduce((s, d) => s + d.size, 0);

    const containers = containersDef.map((c, i) => {
      const running = c.state === 'running';
      const cpu = running ? ctrW[i]() + (c.name === 'jellyfin' && tick % 20 > 16 ? 160 : 0) : 0;
      const mem = running ? c.mem * (0.95 + rand() * 0.1) : 0;
      return {
        id: (0xabc000 + i * 7919).toString(16) + 'f3e2a1', name: c.name, image: c.image, state: c.state,
        uptime: running ? c.up + (t - bootAt) % 86400 : null, status: running ? 'Up' : 'Exited (0) 2 days ago',
        cpu: +cpu.toFixed(1), mem_bytes: mem, mem_percent: +(mem / memTotal * 100).toFixed(1), ports: c.ports,
        rx_rate: running ? rxR * (c.name === 'jellyfin' ? 0.05 : c.name === 'qbittorrent' ? 0.7 : 0.02) * (0.6 + rand() * 0.8) : 0,
        tx_rate: running ? txR * (c.name === 'jellyfin' ? 0.6 : c.name === 'qbittorrent' ? 0.3 : 0.02) * (0.6 + rand() * 0.8) : 0,
      };
    });

    snap = {
      ts: t,
      uptime: t - bootAt,
      system,
      cpu: {
        percent: cpuPct, per_core, cores: cpuCores, threads: cpuCores, sockets: 1, model: system.model,
        freq_mhz: 1800 + cpuPct * 16, load: [cpuPct / 100 * 8 * 0.6, cpuPct / 100 * 8 * 0.5, cpuPct / 100 * 8 * 0.45].map(v => +v.toFixed(2)),
      },
      mem: {
        total: memTotal, used: memUsed, percent: memPct,
        buffers: 0.6 * GiB, cached: 9.4 * GiB, available: memTotal - memUsed,
        swap_total: 4 * GiB, swap_used: 0.12 * GiB, swap_percent: 3,
      },
      disk_total: poolUsed / poolSize * 100, disk_used: poolUsed, disk_size: poolSize, disk_pools: 4,
      disks_detail, diskio,
      net: [
        { name: 'enp1s0', rx_rate: rxR * 0.92, tx_rate: txR * 0.94, speed: 2500, rx_total: 18.4 * TiB, tx_total: 6.2 * TiB },
        { name: 'enp2s0', rx_rate: rxR * 0.08, tx_rate: txR * 0.06, speed: 2500, rx_total: 0.9 * TiB, tx_total: 0.3 * TiB },
      ],
      temp: {
        cpu: cpuT, system: W.mb(),
        disks: disks_detail.map(d => ({ name: d.name, temp: d.temp, standby: d.standby })),
      },
      sensors: {
        fans: [{ name: 'CPU_FAN', rpm: W.fan() }, { name: 'SYS_FAN1', rpm: 980 + rand() * 40 }],
        voltages: [{ name: 'Vcore', v: 0.92 + rand() * 0.03 }, { name: '+12V', v: 12.08 }, { name: '+5V', v: 5.02 }, { name: '+3.3V', v: 3.31 }],
        temps: [
          { name: 'Package id 0', temp: cpuT }, { name: 'Core 0', temp: cpuT - 2 }, { name: 'Core 4', temp: cpuT - 1 },
          { name: 'acpitz', temp: 27.8 }, { name: 'nvme Composite', temp: disks_detail[0].temp }, { name: 'PCH', temp: 48.5 },
        ],
      },
      power: {
        ok: true, source: 'rapl', package: pkg, core: pkg * 0.62, uncore: pkg * 0.12, dram: 1.6,
        base: 8, disks_w: activeDisks.filter(d => d.type === 'hdd').length * 6.5 + 2.5, disks_active: activeDisks.length,
        total: pkg + 1.6 + 8 + activeDisks.filter(d => d.type === 'hdd').length * 6.5 + 2.5,
      },
      gpu: [{ name: 'Intel UHD Graphics (ADL-N)', util: W.gpu() + (tick % 20 > 16 ? 45 : 0), freq: 750, mem_used: null, temp: null, engines: { render: 12, video: tick % 20 > 16 ? 64 : 8 } }],
      docker: { available: true, images: 23, containers },
      memory_slots: [
        { loc: 'DIMM 0', size: 32 * GiB, type: 'DDR5', speed: 4800, mfr: 'Crucial', part: 'CT32G48C40S5' },
      ],
    };
    listeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
    return snap;
  }
  step();
  setInterval(step, 2000);

  // ---------- 历史序列 ----------
  // 有昼夜节律的确定性曲线：晚高峰 20-23 点观影/下载，凌晨 3 点计划任务
  function diurnal(ts) {
    const h = (new Date(ts * 1000).getHours() + new Date(ts * 1000).getMinutes() / 60);
    const evening = Math.exp(-((h - 21.5) ** 2) / 4);
    const night = Math.exp(-((h - 3) ** 2) / 0.4);
    const day = Math.exp(-((h - 14) ** 2) / 10) * 0.4;
    return { evening, night, day };
  }
  function rawNoise(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }
  // 小数索引时在相邻整数点间做 smoothstep 插值，避免短时间范围下出现阶梯状曲线
  function noise(i, k) { const a = Math.floor(i), f = i - a; if (!f) return rawNoise(a, k); const s = f * f * (3 - 2 * f); return rawNoise(a, k) * (1 - s) + rawNoise(a + 1, k) * s; }
  const METRICS = {
    cpu: (ts, i) => { const d = diurnal(ts); return clamp(8 + d.evening * 30 + d.night * 55 + d.day * 10 + noise(i, 1) * 10 + (noise(i, 2) > 0.985 ? 40 : 0), 1, 99); },
    mem: (ts, i) => { const d = diurnal(ts); return clamp(42 + d.evening * 8 + d.night * 6 + noise(i, 3) * 1.5, 0, 100); },
    disk: (ts, i, n, i0) => 64.2 + (i / n) * 1.6,
    rx: (ts, i) => { const d = diurnal(ts); return Math.max(0, (2 + d.evening * 40 + d.night * 70 + noise(i, 4) * 6) * MiB); },
    tx: (ts, i) => { const d = diurnal(ts); return Math.max(0, (0.6 + d.evening * 22 + d.day * 4 + noise(i, 5) * 2.5) * MiB); },
    temp: (ts, i) => { const d = diurnal(ts); return 46 + d.evening * 9 + d.night * 14 + noise(i, 6) * 2.5; },
    tempMb: (ts, i) => { const d = diurnal(ts); return 39 + d.evening * 3 + d.night * 4 + noise(i, 7) * 0.8; },
    power: (ts, i) => { const d = diurnal(ts); return 31 + d.evening * 11 + d.night * 16 + noise(i, 8) * 3; },
    fan: (ts, i) => { const d = diurnal(ts); return 1250 + d.evening * 260 + d.night * 480 + noise(i, 9) * 80; },
    diskR: (ts, i) => { const d = diurnal(ts); return Math.max(0, (6 + d.evening * 60 + d.night * 180 + noise(i, 10) * 15)); },
    diskW: (ts, i) => { const d = diurnal(ts); return Math.max(0, (2 + d.night * 120 + d.day * 8 + noise(i, 11) * 6)); },
    load1: (ts, i) => METRICS.cpu(ts, i) / 100 * 8 * 0.6,
  };
  const RANGES = { '10m': 600, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
  function history(metric, range = '24h', points = 240) {
    const span = typeof range === 'number' ? range : (RANGES[range] || 86400);
    const end = Date.now() / 1000, start = end - span, stepS = span / (points - 1);
    const f = METRICS[metric];
    if (!f) return [];
    const out = [];
    for (let i = 0; i < points; i++) {
      const ts = start + i * stepS;
      const gi = ts / Math.max(60, stepS); // 以绝对时间作为噪声索引（可为小数，插值平滑），不同范围下形状一致
      out.push([ts, f(ts, gi, points, i)]);
    }
    // 最后一个点接上实时值
    const live = { cpu: snap.cpu.percent, mem: snap.mem.percent, temp: snap.temp.cpu, power: snap.power.total }[metric];
    if (live != null) out[out.length - 1][1] = live;
    return out;
  }

  // ---------- 统计类 ----------
  function traffic() {
    return {
      today: { rx: 186.4 * GiB, tx: 42.7 * GiB },
      month: { rx: 2.81 * TiB, tx: 0.94 * TiB },
      boot: { rx: 6.12 * TiB, tx: 1.87 * TiB },
      ifaces: snap.net.map(n => ({ name: n.name, rx_total: n.rx_total, tx_total: n.tx_total, speed: n.speed, drops: n.name === 'enp1s0' ? 12 : 0, errs: 0 })),
      containers: snap.docker.containers.filter(c => c.state === 'running')
        .map((c, i) => ({ name: c.name, rx: [820, 94, 2, 1420, 6.2, 38, 1.1, 22][i] * GiB, tx: [2310, 31, 1, 380, 2.1, 51, 0.7, 9][i] * GiB }))
        .sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx)),
      // 最近 30 天每日流量
      daily: Array.from({ length: 30 }, (_, i) => ({ day: i, rx: (40 + noise(i, 20) * 180 + (i % 7 >= 5 ? 90 : 0)) * GiB, tx: (12 + noise(i, 21) * 50) * GiB })),
    };
  }
  function powerStats() {
    return {
      source: 'rapl', rate: 0.6,
      today_kwh: 0.84, month_kwh: 11.9, today_cost: 0.5, month_cost: 7.14,
      avg_w: 36.2, peak_w: 71.4,
      daily: Array.from({ length: 30 }, (_, i) => ({ day: i, kwh: 0.78 + noise(i, 30) * 0.28 })),
    };
  }
  function monthly() {
    return {
      month: '2026-09', cpu_avg: 14.6, cpu_max: 97.2, mem_avg: 47.1, mem_max: 71.0,
      temp_avg: 50.8, temp_max: 78.0, rx: 3.42 * TiB, tx: 1.06 * TiB, kwh: 26.3, cost: 15.78, load_avg: 0.82,
    };
  }
  function ports() {
    return {
      apps: [
        { name: '影视', port: 8001, running: true, kind: 'fnOS' }, { name: '相册', port: 8002, running: true, kind: 'fnOS' },
        { name: '音乐', port: 8003, running: false, kind: 'fnOS' }, { name: '飞牛监控', port: 8777, running: true, kind: 'fnOS' },
      ],
      docker: snap.docker.containers.filter(c => c.ports).map(c => ({ name: c.name, ports: c.ports, running: c.state === 'running' })),
      listen: [
        [22, 'tcp', 'sshd'], [80, 'tcp', 'docker-proxy'], [139, 'tcp', 'smbd'], [443, 'tcp', 'docker-proxy'], [445, 'tcp', 'smbd'],
        [2283, 'tcp', 'docker-proxy'], [5244, 'tcp', 'docker-proxy'], [5666, 'tcp', 'trim_sac'], [8080, 'tcp', 'docker-proxy'],
        [8096, 'tcp', 'docker-proxy'], [8123, 'tcp', 'docker-proxy'], [8777, 'tcp', 'python3'], [5353, 'udp', 'avahi-daemon'],
      ].map(([port, proto, proc]) => ({ port, proto, proc, addr: port === 22 ? '0.0.0.0' : '*' })),
    };
  }
  function apps() {
    return [
      { name: '相册', icon: 'photos', running: true, stats: { 照片: 48213, 视频: 2190, 人物: 37, 占用: 612 * GiB } },
      { name: '影视', icon: 'video', running: true, stats: { 电影: 412, 剧集: 86, 集数: 2934, 占用: 9.8 * TiB } },
      { name: '音乐', icon: 'music', running: false, stats: { 歌曲: 6120, 专辑: 488, 歌手: 302, 占用: 186 * GiB } },
    ];
  }
  function processes() {
    return procDef.map(([comm, user, args], i) => {
      const base = [42, 28, 8, 6, 3, 1.4, 1.1, 0.8, 0.6, 0.5, 0.3, 0.2][i];
      const boost = (i <= 1 && tick % 20 > 16) ? 2.4 : 1;
      return { pid: 1000 + i * 337, comm, user, args, cpu: base * boost * (0.7 + rand() * 0.6), mem: [2.6, 0.9, 4.4, 1.9, 1.2, 0.3, 0.6, 0.2, 0.4, 1.7, 0.1, 0.3][i], rss: [820, 290, 1420, 610, 380, 92, 190, 64, 120, 540, 28, 96][i] * MiB };
    }).sort((a, b) => b.cpu - a.cpu);
  }
  function weather() {
    return { city: '杭州市（浙江省）', temp: 21.4, text: '多云', code: 'cloudy', high: 24, low: 17, humidity: 68, wind: '东北风 2 级', aqi: 42 };
  }
  function lunar() { return { text: '丙午年 八月廿三', gz: '丁亥月 · 庚戌日', term: '寒露后第 5 天' }; }

  // ---------- 健康评估（新设计里的"一句话结论"） ----------
  function health() {
    const s = snap, issues = [];
    if (s.cpu.percent > 85) issues.push({ level: 'warn', key: 'cpu', text: 'CPU 持续高负载' });
    if (s.temp.cpu > 80) issues.push({ level: 'crit', key: 'temp', text: 'CPU 温度过高' });
    s.disks_detail.forEach(d => { if (d.reallocated_sectors > 0) issues.push({ level: 'warn', key: 'disk:' + d.name, text: d.name + ' 有 ' + d.reallocated_sectors + ' 个重映射扇区' }); });
    s.disks_detail.forEach(d => { if (d.percent > 80) issues.push({ level: 'info', key: 'cap:' + d.name, text: d.name + ' 已用 ' + d.percent.toFixed(0) + '%' }); });
    const stopped = s.docker.containers.filter(c => c.state !== 'running').length;
    if (stopped) issues.push({ level: 'info', key: 'docker', text: stopped + ' 个容器已停止' });
    const level = issues.some(i => i.level === 'crit') ? 'crit' : issues.some(i => i.level === 'warn') ? 'warn' : 'ok';
    return { level, issues };
  }

  // ---------- 格式化工具 ----------
  const fmt = {
    bytes(b, d = 1) {
      if (b == null || !isFinite(b)) return '--';
      const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; let i = 0;
      while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
      return (i === 0 ? Math.round(b) : b.toFixed(b >= 100 ? 0 : d)) + ' ' + u[i];
    },
    bytesParts(b, d = 1) { const s = fmt.bytes(b, d).split(' '); return { v: s[0], u: s[1] || '' }; },
    rate(b) { return fmt.bytes(b) + '/s'; },
    dur(sec) {
      sec = Math.floor(sec); const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
      return d ? d + ' 天 ' + h + ' 小时' : h ? h + ' 小时 ' + m + ' 分' : m + ' 分钟';
    },
    pct(v, d = 0) { return v == null ? '--' : v.toFixed(d); },
  };

  window.FN = {
    get snap() { return snap; },
    onTick(fn) { listeners.add(fn); fn(snap); return () => listeners.delete(fn); },
    history, RANGES, traffic, powerStats, monthly, ports, apps, processes, weather, lunar, health, fmt,
    // 模拟容器操作
    dockerAct(name, act) {
      const c = containersDef.find(x => x.name === name); if (!c) return;
      return new Promise(r => setTimeout(() => { c.state = act === 'stop' ? 'exited' : 'running'; if (c.state === 'running') { c.cpu = c.cpu || 0.5; c.mem = c.mem || 64 * MiB; c.up = 0; } step(); r(); }, 900));
    },
  };
})();
