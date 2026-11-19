// 右侧小窗：展示 Blender 导出的探测器模型，悬停部件显示说明
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const PART_NAMES = {
  Bus: '主体（十边形电子舱）', HGA: '高增益天线', Golden_Record: '金唱片', RTG_Boom: 'RTG 支撑杆',
  RTG_1: '核电源 RTG ①', RTG_2: '核电源 RTG ②', RTG_3: '核电源 RTG ③', Science_Boom: '科学仪器杆',
  Scan_Platform: '扫描平台', MAG_Boom: '磁强计杆', PRA_PWS_Antennas: '射电 / 等离子波天线',
};

export function createModelView(container, gltfScene, infoEl) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xfff4e6, 2.6); key.position.set(6, 8, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.4); rim.position.set(-6, 2, -8); scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.15));

  const model = gltfScene.clone(true);
  // 以主体 + 天线为中心，长杆允许出画
  model.position.set(0, -0.2, 0);
  const pivot = new THREE.Group(); pivot.add(model); scene.add(pivot);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  camera.position.set(7.5, 4.2, 9.5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.2, 0);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.9;
  controls.enablePan = false;
  controls.minDistance = 4; controls.maxDistance = 30;

  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let hovered = null;
  const highlight = (obj, on) => {
    obj?.traverse((m) => {
      if (!m.isMesh) return;
      if (on) { m.userData._mat = m.material; m.material = m.material.clone(); m.material.emissive = new THREE.Color(0x0a84ff); m.material.emissiveIntensity = 0.35; }
      else if (m.userData._mat) { m.material.dispose(); m.material = m.userData._mat; delete m.userData._mat; }
    });
  };
  const partOf = (o) => { while (o && !PART_NAMES[o.name]) o = o.parent; return o; };
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(model, true)[0];
    const part = hit ? partOf(hit.object) : null;
    if (part !== hovered) {
      highlight(hovered, false); highlight(part, true); hovered = part;
      controls.autoRotate = !part;
      if (part) {
        const desc = (part.userData.desc || '').split('：');
        infoEl.innerHTML = `<b>${PART_NAMES[part.name]}</b><span>${desc[1] || desc[0]}</span>`;
      }
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => { highlight(hovered, false); hovered = null; controls.autoRotate = true; });

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container); resize();

  return {
    // sunDir：探测器坐标系下的太阳方向，让小窗光照与真实情况一致
    update(sunDirLocal) {
      if (sunDirLocal) key.position.copy(sunDirLocal).multiplyScalar(10);
      controls.update();
      renderer.render(scene, camera);
    },
    pivot,
  };
}
