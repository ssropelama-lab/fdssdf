# Гранаты M67 / M84 — общее ядро на three.js 0.166.1

Исходники в `grenades/src`, сборка `npm run build` (esbuild) пишет два самодостаточных
HTML в корень репозитория: `m67_grenade_model.html`, `flashbang_m84.html`. three.js не
бандлится — берётся с unpkg по importmap (`three`, `three/addons/`), как в `forest_map_camp.html`.
Для разработки: `npm run build -- --dev` создаёт `grenades/m67.html` и `grenades/m84.html`,
`npm run serve` поднимает статический сервер (корень — репозиторий).

## Соглашения

* ES-модули, `import * as THREE from 'three'`. Никаких других зависимостей.
* Единицы — метры, секунды, килограммы. +Y вверх. Пол `y = 0`.
* Комментарии короткие, по-русски, только про неочевидное. UI на русском.
* Горячий путь (кадр, взрыв) без аллокаций: векторы/матрицы/массивы создаются заранее.
* Никаких синусоидальных звуков длиннее ~40 мс (см. audio).
* Всё случайное во взрыве — от `seed` через `mulberry32` из `core/rng.js`.

## Модули

| файл | что делает |
|---|---|
| `core/rng.js` | `mulberry32(seed)`, `hash32`, `randRange` |
| `core/state.js` | автомат состояний гранаты |
| `core/physics.js` | твёрдые тела из сфер-коллайдеров, пол/стены/ящики, прокат, отскок |
| `core/particles.js` | GPU-частицы: кольцевой буфер, траектория аналитически в вершинном шейдере |
| `core/smoke.js` | дым: объёмный raymarch (½/¼) или инстансированные спрайты с атласом |
| `core/post.js` | HDR-постобработка (см. контракт ниже) |
| `core/audio.js` | звук (см. контракт ниже) |
| `core/scenes.js` | студия и полигон, свет, окружение |
| `core/director.js` | камеры: свободная орбита, «режиссёр», повтор |
| `core/quality.js` | профили low/med/high, автоподстройка разрешения, «ослабить вспышки» |
| `core/bench.js` | стенд `?bench=1` |
| `core/app.js` | склейка: механика, ввод, цикл рендера по требованию |
| `core/ui.js` | HUD, панель, таймлайн повтора |
| `m67/model.js` | модель M67 + процедурная запечка текстур в карты MeshStandardMaterial |
| `m67/blast.js` | взрыв M67 |
| `m84/model.js` | модель M84 |
| `m84/blast.js` | взрыв M84 |

## Контракт `core/post.js`

```js
import { PostPipeline } from './post.js';
const post = new PostPipeline(renderer, quality);   // quality — объект профиля из quality.js
post.setSize(cssW, cssH, pixelRatio);               // пересоздаёт цели
post.setQuality(quality);                           // { msaa: 0|4, bloomLevels: 4..6, fxScale: 0.5|1, ... }
post.setResolutionScale(s);                         // 0.5..1, динамическое разрешение (с гистерезисом у вызывающего)
post.render(scene, fxScene, camera, dt, accumIndex);
//  1) scene   → HDR RT (HalfFloat, MSAA по профилю, depthTexture)
//  2) fxScene → fxRT (HalfFloat, без своей глубины, масштаб fxScale). Материалы fx сами делают
//     мягкий тест глубины по post.fxUniforms.tDepth. Смешивание премультиплицированное:
//     дым ONE/ONE_MINUS_SRC_ALPHA, огонь/искры ONE/ONE (alpha 0). Композит: scene*(1-fx.a)+fx.rgb
//  3) post.volume (если задан) — объёмный дым в своей цели низкого разрешения, тот же композит
//  4) bloom dual Kawase по цепочке мипов, грязь на объективе × bloom
//  5) композит: искажение ударной волны и марево → хром. аберрация → +bloom → +вспышка (HDR)
//     → остаточное изображение → экспозиция/адаптация → тонмаппинг AgX/ACES → sRGB, виньетка, зерно, дизеринг
//  accumIndex: 0 — движение (обычный кадр); n>0 — сцена стоит, n-й кадр прогрессивного
//  накопления (post сам сдвигает проекцию по Halton и смешивает 1/n).
post.fxUniforms   // { tDepth, uCamNear, uCamFar, uFxRes } — общие uniform-объекты для fx-материалов
post.params = {
  exposure: 1, toneMapper: 'agx'|'aces',
  bloomStrength, bloomThreshold, dirtStrength,
  flash: 0,               // HDR-засветка до тонмаппинга (линейные единицы, 0..~200)
  flashTint: THREE.Color,
  adapt: 1,               // множитель экспозиции «глаза» (после вспышки < 1 и растёт)
  chroma: 0,              // хром. аберрация 0..1
  shock: { strength, center: Vector3, radius, width },   // мировые метры, post проецирует сам
  haze:  { strength, center: Vector3, radius },          // марево над запалом
  after: { strength, offset: Vector2 },                  // остаточное изображение (инверсия), offset в uv
  vignette, grain,
};
post.captureAfterimage();  // копирует текущий HDR кадр в текстуру низкого разрешения
post.volume = { enabled, render(renderer, camera, depthTexture, target) }  // хук объёмного дыма
post.info → { scale, accum }
post.dispose();
```

## Контракт `core/audio.js`

```js
import { AudioEngine } from './audio.js';
const audio = new AudioEngine();
await audio.unlock();                 // по первому жесту: создать/возобновить AudioContext, загрузить worklet
audio.prerender();                    // в простое: OfflineAudioContext → 3–4 варианта хлопков M67/M84 + банк ударов
audio.setListener(camera);            // каждый кадр
audio.play(name, { pos, gain, rate, seed });
//  имена: 'clip' (щелчок клипа), 'spring' (клац пружины рычага), 'leverHit', 'pinHit', 'clipHit',
//         'bodyHit' (корпус о пол, gain ~ скорость), 'primer' (щёлк-пух капсюля), 'ring' (звяк кольца — БЕЗ тона!)
audio.scrape.start(); audio.scrape.set(velocity, normalForce); audio.scrape.stop();   // чека, AudioWorklet stick-slip
audio.whoosh.start(); audio.whoosh.set(speed, pos); audio.whoosh.stop();              // свист летящего рычага
audio.fuse.start(pos, duration); audio.fuse.setPos(pos); audio.fuse.stop();           // шипение/потрескивание замедлителя
audio.blast('m67'|'m84', { pos, seed, occlusion });  // один буфер из заранее отрендеренных + фильтр по дистанции
//  M67: удар + треск, свист/щелчки осколков, стук мусора. M84: резкий хлопок + заглушение слуха
//  (lowpass 18 кГц → 800 Гц, восстановление 10–20 с) и опционально звон (узкополосный шум).
audio.replay(kind, slow);             // звук для слоу-мо повтора
audio.setMuted(b); audio.setTinnitus(b); audio.suspend(); audio.resume(); audio.stopAll();
audio.stats → { nodes, variants }
```

## Контракт `m67/model.js`

```js
import { buildM67 } from '../m67/model.js';
const m = await buildM67({ renderer, quality: 'low'|'med'|'high', wear, rust, smudge });
m.group          // THREE.Group, начало координат — центр сферы корпуса, запал по +Y
m.parts          // { body, fuze, lever, pin, ring, clip } — Object3D, начало каждого = его шарнир/пивот
m.bodyMesh       // единый Mesh корпуса (MeshStandardMaterial), ядро патчит его onBeforeCompile (раздутие/трещины)
m.dims           // { R: 0.03175, height: ~0.089, fuzeTop, mass: 0.4 }
m.pin            // { axis: Vector3 (в пространстве group, куда выходит чека), travel, set(d) }
m.lever          // { hinge: Vector3, axis: Vector3, colliders: [{p, r}] (в локали parts.lever) }
m.clip           // { set(on), colliders }
m.fuzeVent       // Vector3, откуда выходит дым капсюля
m.cutaway        // { set(on), burn(f 0..1) } — разрез запала с горящим замедлителем
m.rebake(opts)   // перезапечь карты
m.maps           // { map, normalMap, roughnessMap/metalnessMap/aoMap (ORM) } — CanvasTexture/DataTexture/RT
m.dispose()
```
