// The model page: decode the link, draw the model (dark faces, ink creases, turning slowly; drag to turn it yourself),
// with a parts panel to show, hide and restyle each part, and make print files in the browser. Nothing is uploaded:
// the model lives in the link (or, for a short link, in the Gist it names).
import { parseHash, decode, fromGist, triangles, partsOf, stl, threemf, filename } from './model-link.mjs?v=ff7ea5d';
import { WebGLRenderer, Scene, PerspectiveCamera, BufferGeometry, Float32BufferAttribute, Mesh, MeshLambertMaterial, LineSegments,
  EdgesGeometry, LineBasicMaterial, AmbientLight, DirectionalLight, Group, WireframeGeometry, Raycaster, Vector2, Vector3, Box3 } from './three.min.js?v=ff7ea5d';

const $ = (id) => document.getElementById(id);
const DRAWER = '(max-width: 760px), (pointer: coarse) and (max-width: 1100px)'; // the same query as the drawer's CSS
const status = (t) => { $('status').textContent = t; };

function download(model, kind) {
  const bytes = kind === '3mf' ? threemf(model) : stl(model), name = filename(model, kind);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: kind === '3mf' ? 'model/3mf' : 'model/stl' })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  status(`Downloaded ${name}`);
}

// ---------- the project view ----------
// Each part is drawn three ways (faces, crease lines, every triangle's edges); its style picks which show:
//   solid (faces + creases), wire (every edge), xray (see-through faces + creases), faint (creases in ink-3), hidden.
// A part's style is "auto" until set: supports and references are faint, real parts follow the view mode.
const INK = { 1: 0xffffff, 2: 0xb4b4b4, 3: 0x5c5c5c }, STYLES = ['auto', 'solid', 'wire', 'xray', 'faint'];

function show(model) {
  document.title = `${model.title || 'Model'} ${model.version || ''}`.trim();
  $('title').textContent = model.title || 'Model';
  $('meta').textContent = [model.version, model.material, model.set && `set ${model.set}`, model.src].filter(Boolean).join(' · ');
  $('note').textContent = model.orientation || '';
  $('rules').replaceChildren(...(model.rules || []).map(([label, value, unit]) => {
    const li = document.createElement('li'), b = document.createElement('b');
    b.textContent = `${value}${unit && unit !== 'segments' ? ` ${unit}` : ''}`; li.append(`${label} `, b); return li;
  }));

  // Parts: JSCAD's Z-up becomes three's Y-up; everything centred on the turning axis
  const parts = partsOf(model).map((part, k) => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(triangles(model, part).flat(2), 3));
    g.rotateX(-Math.PI / 2); g.computeVertexNormals(); g.computeBoundingBox();
    return { k, name: part[0], role: part[1], label: part[2], g, visible: true, style: 'auto' };
  });
  const box = new Box3(); parts.forEach((p) => box.union(p.g.boundingBox));
  const mid = box.getCenter(new Vector3()), r = box.getSize(new Vector3()).length() / 2 || 1;
  const turn = new Group(), tilt = new Group();
  for (const p of parts) {
    p.g.translate(-mid.x, -mid.y, -mid.z); p.g.computeBoundingBox();
    p.faces = new MeshLambertMaterial({ color: 0x3a3a3a, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: true });
    p.creaseInk = new LineBasicMaterial({ color: INK[1] }); p.wireInk = new LineBasicMaterial({ color: INK[2] });
    p.mesh = new Mesh(p.g, p.faces); p.creases = new LineSegments(new EdgesGeometry(p.g, 25), p.creaseInk);
    p.wire = null; // made the first time it's needed
    p.node = new Group(); p.node.add(p.mesh, p.creases); p.mesh.userData.part = p;
    turn.add(p.node);
  }
  tilt.add(turn); tilt.rotation.x = 0.45;
  const scene = new Scene();
  scene.add(tilt, new AmbientLight(0xffffff, 0.6));
  const sun = new DirectionalLight(0xffffff, 2.2); sun.position.set(-1, 2, 1.5); scene.add(sun);

  // ---------- state ----------
  const view = { mode: 'solid', supports: true, references: true, explode: 0, spin: true, selected: new Set() };
  const effective = (p) => {
    if (!p.visible || (p.role === 'support' && !view.supports) || (p.role === 'reference' && !view.references)) return 'hidden';
    return p.style !== 'auto' ? p.style : p.role !== 'part' ? 'faint' : view.mode;
  };
  const apply = () => {
    for (const p of parts) {
      const st = effective(p), sel = view.selected.has(p);
      p.mesh.visible = st === 'solid' || st === 'xray';
      p.faces.opacity = st === 'xray' ? (sel ? 0.6 : 0.18) : 1; p.faces.depthWrite = st !== 'xray'; // selected: lit up in any mode
      p.faces.color.setHex(sel ? 0x8a8a8a : 0x3a3a3a);
      p.creases.visible = st === 'solid' || st === 'xray' || st === 'faint';
      p.creaseInk.color.setHex(st === 'faint' && !sel ? INK[3] : INK[1]);
      if (st === 'wire' && !p.wire) { p.wire = new LineSegments(new WireframeGeometry(p.g), p.wireInk); p.node.add(p.wire); }
      if (p.wire) { p.wire.visible = st === 'wire'; p.wireInk.color.setHex(sel ? INK[1] : INK[2]); }
    }
    // Explode: each kind of part lifts above the one below it; supports drop away underneath
    const kinds = [...new Set(parts.filter((p) => p.role !== 'support').map((p) => p.label))]
      .map((label) => ({ label, y: Math.min(...parts.filter((p) => p.label === label).map((p) => p.g.boundingBox.min.y)) })).sort((a, b) => a.y - b.y);
    const gap = (box.max.y - box.min.y) * 0.9 * view.explode;
    for (const p of parts) p.node.position.y = p.role === 'support' ? -gap : kinds.findIndex((x) => x.label === p.label) * gap;
    renderTree();
  };

  // ---------- the parts list: kinds (keycap ×9), each opening to its copies (key-1-1), each copy all its parts ----------
  const instanceOf = (p) => { const bits = p.name.split('.'); return bits.length > 2 ? bits.slice(0, -1).join('.') : bits[0]; }; // key-1-1.switch.stem -> key-1-1.switch
  const groups = [];
  for (const p of parts) {
    let g = groups.find((x) => x.label === p.label);
    if (!g) groups.push(g = { label: p.label, role: p.role, copies: [], open: false });
    const id = instanceOf(p);
    let c = g.copies.find((x) => x.id === id);
    if (!c) g.copies.push(c = { id, parts: [] });
    c.parts.push(p);
  }
  const all = (g) => g.copies.flatMap((c) => c.parts);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const styleOf = (list) => { const s = new Set(list.map((p) => p.style)); return s.size === 1 ? [...s][0] : 'mixed'; };
  const button = (cls, text, title, fn) => { const b = el('button', cls, text); b.title = title; b.onclick = (e) => { e.stopPropagation(); fn(); }; return b; };
  function controls(list) {
    const shown = list.some((p) => p.visible);
    return [
      button(`eye${shown ? '' : ' off'}`, shown ? '●' : '○', shown ? 'Shown: click to hide' : 'Hidden: click to show', () => { list.forEach((p) => { p.visible = !shown; }); apply(); }),
      button('style', styleOf(list), 'Style: auto, solid, wire, x-ray or faint', () => {
        const next = STYLES[(STYLES.indexOf(styleOf(list)) + 1) % STYLES.length] || 'auto';
        list.forEach((p) => { p.style = next; }); apply();
      }),
    ];
  }
  const isSelected = (list) => list.length && list.every((p) => view.selected.has(p));
  function renderTree() {
    $('tree').replaceChildren(...groups.map((g) => {
      const li = el('li', 'group'), line = el('div', 'line'), single = g.copies.length === 1;
      const tail = el('span', 'tail');
      tail.append(el('span', 'role', `${g.role !== 'part' ? g.role : ''}${single ? '' : `${g.role !== 'part' ? ' ' : ''}×${g.copies.length}`}`), ...controls(all(g)));
      line.append(el('span', 'caret', single ? '' : g.open ? '▾' : '▸'), el('span', 'name', g.label), tail);
      if (single && isSelected(all(g))) line.classList.add('selected');
      line.onclick = () => { if (single) select(all(g)); else { g.open = !g.open; renderTree(); } };
      li.append(line);
      if (!single) {
        const ul = el('ul', 'copies'); ul.hidden = !g.open;
        for (const c of g.copies) {
          const row = el('li', `copy${isSelected(c.parts) ? ' selected' : ''}`), t = el('span', 'tail');
          t.append(...controls(c.parts));
          row.append(el('span', 'caret'), el('span', 'name', c.id.split('.')[0]), t);
          row.title = c.parts.map((p) => p.name).join(', ');
          row.onclick = () => select(c.parts);
          ul.append(row);
        }
        li.append(ul);
      }
      return li;
    }));
  }
  // Select a copy (all its parts): it lights up in the model and in the list, and its size shows below
  function select(list) {
    const same = isSelected(list) && list.length === view.selected.size;
    view.selected = new Set(same ? [] : list);
    if (view.selected.size) {
      const g = groups.find((x) => all(x).includes(list[0])); g.open = true;
      const b = new Box3(); list.forEach((p) => b.union(p.g.boundingBox)); const sz = b.getSize(new Vector3());
      status(`${instanceOf(list[0]).split('.')[0]}: ${list[0].label}${list[0].role !== 'part' ? ` (${list[0].role})` : ''}, ${sz.x.toFixed(1)} × ${sz.z.toFixed(1)} × ${sz.y.toFixed(1)} mm`);
    } else status('');
    apply();
  }

  // ---------- controls ----------
  for (const b of $('mode').querySelectorAll('button')) b.onclick = () => { view.mode = b.dataset.mode; $('mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); apply(); };
  $('explode').oninput = (e) => { view.explode = Number(e.target.value); apply(); };
  $('spin').onchange = (e) => { view.spin = e.target.checked; };
  $('supports').onchange = (e) => { view.supports = e.target.checked; apply(); };
  $('references').onchange = (e) => { view.references = e.target.checked; apply(); };
  $('reset').onclick = () => {
    Object.assign(view, { mode: 'solid', supports: true, references: true, explode: 0, spin: true, selected: new Set() });
    parts.forEach((p) => { p.visible = true; p.style = 'auto'; });
    $('explode').value = 0; $('spin').checked = $('supports').checked = $('references').checked = true;
    $('mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.mode === 'solid'));
    turn.rotation.y = 0; tilt.rotation.x = 0.45; status(''); apply();
  };
  $('supports').closest('label').hidden = !parts.some((p) => p.role === 'support');
  $('references').closest('label').hidden = !parts.some((p) => p.role === 'reference');
  // The panel: a side panel on wide screens; on phones a drawer, closed at first and closed by tapping the model
  const narrow = matchMedia(DRAWER);
  const panel = (open) => { $('panel').hidden = !open; $('toggle').hidden = open && narrow.matches; };
  $('toggle').onclick = () => panel($('panel').hidden);
  $('close').onclick = () => panel(false);
  $('stage').addEventListener('pointerdown', () => { if (narrow.matches && !$('panel').hidden) panel(false); }, true);
  panel(!narrow.matches);

  // ---------- drawing ----------
  const stage = $('stage'), renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setClearColor(0x000000);
  stage.append(renderer.domElement);
  const camera = new PerspectiveCamera(30, 1, r / 100, r * 30);
  const size = () => {
    const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.position.set(0, 0, (r * 1.15) / Math.tan((Math.PI / 180) * 15) / Math.min(1, camera.aspect)); camera.updateProjectionMatrix();
  };
  new ResizeObserver(size).observe(stage); size();

  // Drag turns and tilts; a click without a drag picks the part under the pointer
  let drag = null, last = performance.now();
  const ray = new Raycaster(), at = new Vector2();
  stage.addEventListener('pointerdown', (e) => { if (e.target !== renderer.domElement) return; drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    turn.rotation.y += (e.clientX - drag.x) * 0.01; tilt.rotation.x = Math.max(-1.4, Math.min(1.4, tilt.rotation.x + (e.clientY - drag.y) * 0.01));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  stage.addEventListener('pointerup', (e) => {
    if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) {
      const rect = renderer.domElement.getBoundingClientRect();
      at.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(at, camera);
      const hit = ray.intersectObjects(parts.filter((p) => effective(p) !== 'hidden').map((p) => p.mesh))[0];
      if (hit) { const p = hit.object.userData.part, id = instanceOf(p); select(parts.filter((q) => q.label === p.label && instanceOf(q) === id)); }
    }
    drag = null;
  });
  renderer.setAnimationLoop((now) => {
    if (!drag && view.spin) turn.rotation.y += ((now - last) / 60000) * 2 * Math.PI;
    last = now; renderer.render(scene, camera);
  });
  apply();
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
