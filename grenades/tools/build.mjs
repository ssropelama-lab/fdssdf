// Сборка: src/<id>/main.js → один самодостаточный HTML в корне репозитория
// (three.js 0.166.1 берётся с unpkg через importmap, как в forest_map_camp.html).
// Заодно пишет dev-страницы grenades/<id>.html, которые грузят исходники напрямую.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '..');

const APPS = [
  { id: 'm67', out: 'm67_grenade_model.html', title: 'M67 · осколочная граната', lang: 'ru' },
  { id: 'm84', out: 'flashbang_m84.html', title: 'M84 · светошумовая граната', lang: 'ru' },
];

const IMPORTMAP = '{"imports":{"three":"https://unpkg.com/three@0.166.1/build/three.module.js","three/addons/":"https://unpkg.com/three@0.166.1/examples/jsm/"}}';

function page(app, body) {
  return `<!DOCTYPE html>
<html lang="${app.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${app.title}</title>
<script type="importmap">
${IMPORTMAP}
</script>
</head>
<body>
${body}
</body>
</html>
`;
}

const devOnly = process.argv.includes('--dev');

for (const app of APPS) {
  await writeFile(path.join(root, `${app.id}.html`),
    page(app, `<script type="module" src="./src/${app.id}/main.js"></script>`));
  if (devOnly) continue;
  const res = await build({
    entryPoints: [path.join(root, 'src', app.id, 'main.js')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    external: ['three', 'three/addons/*'],
    write: false,
    legalComments: 'none',
    charset: 'utf8',
  });
  const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = page(app, `<script type="module">\n${js}</script>`);
  await writeFile(path.join(repo, app.out), html);
  console.log(`${app.out}: ${(html.length / 1024).toFixed(1)} KiB`);
}
