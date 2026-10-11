// The model page: decode the link, draw the model (dark faces, ink creases, turning slowly; drag to turn it yourself),
// and make print files in the browser. Nothing is uploaded: the model only ever lives in the link.
import { parseHash, decode, fromGist, triangles, partsOf, stl, threemf, filename } from './model-link.mjs';
import { WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, Float32BufferAttribute, Mesh, MeshLambertMaterial, LineSegments,
  EdgesGeometry, LineBasicMaterial, AmbientLight, DirectionalLight, Group } from './three.min.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

function download(model, kind) {
  const bytes = kind === '3mf' ? threemf(model) : stl(model), name = filename(model, kind);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: kind === '3mf' ? 'model/3mf' : 'model/stl' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  status(`Downloaded ${name}`);
}

function show(model) {
  document.title = `${model.title || 'Model'} ${model.version || ''}`.trim();
  $('title').textContent = model.title || 'Model';
  $('meta').textContent = [model.version, model.material, model.set && `set ${model.set}`, model.src].filter(Boolean).join(' · ');
  const supports = partsOf(model).filter((p) => p[1] !== 'part').map((p) => p[2]); // supports and references
  $('note').textContent = [model.orientation, supports.length && `Faint: ${supports.join(', ')}.`].filter(Boolean).join(' ');
  $('rules').replaceChildren(...(model.rules || []).map(([label, value, unit]) => {
    const li = document.createElement('li'), b = document.createElement('b');
    b.textContent = `${value}${unit && unit !== 'segments' ? ` ${unit}` : ''}`; li.append(`${label} `, b); return li;
  }));

  // Geometry per part: JSCAD's Z-up becomes three's Y-up; centred on the turning axis. Supports (printed, then
  // removed) are faint lines only, so the part they hold up shows through.
  const parts = partsOf(model).map((part) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(triangles(model, part).flat(2), 3));
    g.rotateX(-Math.PI / 2); g.computeVertexNormals(); g.computeBoundingBox();
    return { g, support: part[1] !== 'part' };
  });
  const box = parts[0].g.boundingBox.clone(); parts.forEach((p) => box.union(p.g.boundingBox));
  const mid = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
  const r = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;

  const turn = new Group(), tilt = new Group();
  for (const { g, support } of parts) {
    g.translate(-mid[0], -mid[1], -mid[2]);
    if (!support) turn.add(new Mesh(g, new MeshLambertMaterial({ color: 0x3a3a3a, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
    turn.add(new LineSegments(new EdgesGeometry(g, 25), new LineBasicMaterial({ color: support ? 0x5c5c5c : 0xffffff })));
  }
  tilt.add(turn); tilt.rotation.x = 0.45;
  const scene = new Scene();
  scene.add(tilt, new AmbientLight(0xffffff, 0.6));
  const sun = new DirectionalLight(0xffffff, 2.2); sun.position.set(-1, 2, 1.5); scene.add(sun);

  const stage = $('stage'), renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setClearColor(0x000000);
  stage.append(renderer.domElement);
  const camera = new PerspectiveCamera(30, 1, r / 100, r * 20);
  const size = () => {
    const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.position.set(0, 0, (r * 1.15) / Math.tan((Math.PI / 180) * 15) / Math.min(1, camera.aspect)); camera.updateProjectionMatrix();
  };
  new ResizeObserver(size).observe(stage); size();

  // Turns once a minute; dragging turns and tilts it, and it carries on from there.
  let drag = null, last = performance.now();
  stage.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    turn.rotation.y += (e.clientX - drag.x) * 0.01; tilt.rotation.x = Math.max(-1.4, Math.min(1.4, tilt.rotation.x + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', () => { drag = null; });
  renderer.setAnimationLoop((now) => {
    if (!drag) turn.rotation.y += ((now - last) / 60000) * 2 * Math.PI;
    last = now; renderer.render(scene, camera);
  });
}

async function main() {
  const { token: long, gist, get } = parseHash(location.hash);
  let model, token = long;
  try {
    if (!token && gist) token = await fromGist(gist); // a short link: the data is in a Gist
    if (!token) throw new Error('Open a model link made by mirror-cad (cad link).');
    model = await decode(token);
  } catch (e) {
    document.body.innerHTML = `<div class="problem"></div>`;
    document.querySelector('.problem').textContent = e.message;
    return;
  }
  show(model);
  for (const b of document.querySelectorAll('[data-get]')) b.addEventListener('click', () => download(model, b.dataset.get));
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}${gist ? `#s=${gist}` : `#m=${token}`}`); status('Link copied'); // short stays short
  });
  if (get === 'stl' || get === '3mf') download(model, get);
}

window.addEventListener('hashchange', () => location.reload());
main();
