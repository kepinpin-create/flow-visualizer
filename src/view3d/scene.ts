// 3D view of the plan and its replay: walls stand up, blocks become boxes, people walk.
// View-only (editing stays in 2D), and loaded on demand so 2D users never download Three.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BLOCK_STYLES, footprintPx, metersPerPixel, planExtent } from '../editor/blocks';
import type { BlockType, ModelSpec } from '../model/types';
import type { Dot, DotState } from '../replay/replay';

const WALL_HEIGHT_M = 2.4;
const WALL_THICKNESS_M = 0.15;
/** How tall each block stands: counters at desk height, lines and doors flat on the floor. */
const BLOCK_HEIGHT_M: Record<BlockType, number> = {
  source: 0.04, sink: 0.04, queue: 0.02, decision: 0.04, server: 1.05, resource: 1.0, delay: 0.45,
};
const PERSON_HEIGHT_M = 1.6;
const PERSON_RADIUS_M = 0.2;
const LABEL_HEIGHT_M = 0.4;

export interface View3d {
  dispose(): void;
}

export function mountView3d(host: HTMLElement, opts: { getModel: () => ModelSpec; getDots: () => Dot[] | null }): View3d {
  const el = document.createElement('div');
  el.className = 'view3d';
  host.appendChild(el);

  const css = getComputedStyle(document.documentElement);
  const cssColor = (name: string) => new THREE.Color(css.getPropertyValue(name).trim() || '#888888');
  const stateColor: Record<DotState, THREE.Color> = {
    move: cssColor('--dot-move'), wait: cssColor('--dot-wait'), service: cssColor('--dot-service'),
    stay: cssColor('--dot-stay'), balk: cssColor('--dot-balk'),
  };

  // Throws where WebGL is unavailable; the caller reports it.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = cssColor('--bg');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(10, 25, 12);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // never under the floor

  let statics = new THREE.Group();
  scene.add(statics);
  let shown: ModelSpec | null = null;
  let mpp = 0.02;

  const personGeo = new THREE.CapsuleGeometry(PERSON_RADIUS_M, PERSON_HEIGHT_M - 2 * PERSON_RADIUS_M, 4, 8);
  const personMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const newPeople = (capacity: number) => {
    const mesh = new THREE.InstancedMesh(personGeo, personMat, capacity);
    // Its bounds are measured once, while everyone still stands at the plan's corner; people walk out of them.
    mesh.frustumCulled = false;
    return mesh;
  };
  let people = newPeople(64);
  people.count = 0;
  scene.add(people);
  const at = new THREE.Matrix4();

  /** Rebuilds floor, walls, blocks and labels for a model; people are updated every frame. */
  function build(model: ModelSpec) {
    scene.remove(statics);
    disposeTree(statics);
    statics = new THREE.Group();
    scene.add(statics);
    shown = model;
    mpp = metersPerPixel(model);
    const { width, height } = planExtent(model);
    const w = width * mpp;
    const d = height * mpp;

    const floorMat = new THREE.MeshStandardMaterial({ color: cssColor('--plan-bg') });
    const file = model.background?.file;
    if (file?.startsWith('data:')) {
      floorMat.map = new THREE.TextureLoader().load(file, () => (floorMat.needsUpdate = true));
      floorMat.map.colorSpace = THREE.SRGBColorSpace;
      floorMat.color.set(0xffffff);
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(w / 2, 0, d / 2);
    statics.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xd9dde4 });
    for (const line of model.walls ?? []) {
      for (let i = 1; i < line.length; i++) {
        const [x1, y1] = line[i - 1];
        const [x2, y2] = line[i];
        const len = Math.hypot(x2 - x1, y2 - y1) * mpp;
        if (len === 0) continue;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(len, WALL_HEIGHT_M, WALL_THICKNESS_M), wallMat);
        wall.position.set(((x1 + x2) / 2) * mpp, WALL_HEIGHT_M / 2, ((y1 + y2) / 2) * mpp);
        wall.rotation.y = -Math.atan2(y2 - y1, x2 - x1);
        statics.add(wall);
      }
    }

    for (const b of model.blocks) {
      const size = footprintPx(model, b);
      const h = BLOCK_HEIGHT_M[b.type];
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(size.w * mpp, h, size.h * mpp),
        new THREE.MeshStandardMaterial({ color: BLOCK_STYLES[b.type].color, transparent: b.type === 'queue', opacity: 0.6 }),
      );
      box.position.set(b.x * mpp, h / 2, b.y * mpp);
      // Plan y points down, so a clockwise plan rotation is a negative turn about the 3D up axis.
      box.rotation.y = -((b.rotation ?? 0) * Math.PI) / 180;
      statics.add(box);
      const label = textSprite(b.label || b.id);
      label.position.set(b.x * mpp, h + PERSON_HEIGHT_M + 0.3, b.y * mpp);
      statics.add(label);
    }

    const span = Math.max(w, d);
    controls.target.set(w / 2, 0, d / 2);
    camera.position.set(w / 2, span * 0.9, d / 2 + span * 0.55);
    controls.update();
  }

  function drawPeople(dots: Dot[]) {
    if (dots.length > people.instanceMatrix.count) {
      // Grow by doubling so a long line does not reallocate every frame.
      scene.remove(people);
      people.dispose();
      people = newPeople(Math.max(dots.length, people.instanceMatrix.count * 2));
      scene.add(people);
    }
    dots.forEach((dot, i) => {
      at.makeTranslation(dot.x * mpp, PERSON_HEIGHT_M / 2, dot.y * mpp);
      people.setMatrixAt(i, at);
      people.setColorAt(i, stateColor[dot.state]);
    });
    people.count = dots.length;
    people.instanceMatrix.needsUpdate = true;
    if (people.instanceColor) people.instanceColor.needsUpdate = true;
  }

  const resize = () => {
    const { clientWidth: cw, clientHeight: ch } = el;
    if (!cw || !ch) return;
    renderer.setSize(cw, ch);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const model = opts.getModel();
    if (model !== shown) build(model);
    drawPeople(opts.getDots() ?? []);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(statics);
      people.dispose();
      personGeo.dispose();
      personMat.dispose();
      renderer.dispose();
      el.remove();
    },
  };
}

/** A label that always faces the camera, drawn on a small canvas. */
function textSprite(text: string): THREE.Sprite {
  const font = '600 48px system-ui, sans-serif';
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width) + 32;
  c.height = 72;
  ctx.font = font;
  ctx.fillStyle = 'rgba(16, 19, 25, 0.72)';
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, c.height / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set((LABEL_HEIGHT_M * c.width) / c.height, LABEL_HEIGHT_M, 1);
  return sprite;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      m.map?.dispose();
      m.dispose();
    }
  });
}
