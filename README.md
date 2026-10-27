# Holo sticker

Drop, paste or upload a photo. The background is removed in the browser, and the subject becomes a die-cut holographic sticker that you can peel off the table. It starts with the CodeLab team cutout from Figma (`Marketing Workspace 25–26`, node 6409:14) as the demo.

```sh
npm install
npm run dev   # http://localhost:5302
```

## How it works

- **Background removal** (`src/main.ts`, `useFile`): images that already have transparency skip this step. If most of the border is one exact colour (a design export with a solid fill), `keySolidBackground` removes just that colour by flood-filling in from the edges, so nothing inside the subject is touched and no one in a group shot gets dropped. Otherwise `@imgly/background-removal` (the `isnet_fp16` model, ONNX in WASM) runs locally. On first use it downloads the model from IMG.LY's CDN, and the library is lazy-loaded so the page opens fast. Its licence is AGPL, so check that before shipping this publicly.
- **Die cut** (`src/sticker.ts`): the cutout is cropped and padded. On a ≤640px grid, an exact Euclidean distance transform grows the border, small specks are dropped and holes are filled.
  - **Angular** traces the grown outline (Moore neighbour) and simplifies it with RDP into hand-cut facets, like the Figma polygon. It then unions that with a slightly smaller smooth offset, so no facet cuts into the subject.
  - **Smooth** is the offset itself, upsampled bilinearly from the distance field, so the edge stays smooth.
- **Shading** (`src/shaders.ts`): a single full-screen fragment shader in WebGL2. The sticker is flat like paper: no bevel and no thickness shadow. Only the peel gives it shape.
  - The film is pearl white with a cosine-spectrum rainbow. Its phase follows the reflected view, the screen position and where the pointer leans the light, so the bands sweep as you move. A slow fbm swirl bends the bands, and fine grain plus sparse flecks give the glitter.
  - Over the photo, the same rainbow is screened on like a holo laminate. The **Holo on photo** slider controls it.
- **Peel**: a cylinder curl. The grabbed point lands under the pointer. The fold line sits `(L + πR)/2` back from it, and the radius grows with the pull (`CURL`), up to a cap (`CURL_MAX`). Each pixel is inverted to the sticker points that land on it: the flat face-down backing, the outside of the curl (backing) and the inside of the curl (printed face). The lifted flap casts a soft shadow from the coverage mips.
  - Release past `FLY_AT` and the sticker comes off, then re-sticks. Release short of that and a critically damped spring lays it back down. It has no overshoot, so the fold can't flip sides.
- **Shards** blends in a shattered-glass holo pattern. It uses two scales of Voronoi cells, each split into wedges by a random line. Every facet acts as a grating at its own angle, so each flips to its own colour as the view moves. `SHARD_MIX` caps how far it takes over, kept well short of full prism foil.
- **Rim** switches the border between holo film and plain white vinyl (soft gloss only). **B&W** turns the photo to luminance before the laminate goes on, so the holo film stays in colour.
- **Lock**: press `]` while peeling to hold the peel after you let go, and `[` to let it fall back.
- **Saved stickers** (`src/history.ts`): every new sticker goes into this browser's IndexedDB. Each record holds the cut-out (so the background is never removed twice), its settings and a thumbnail. Changing settings updates the open one. The left column lists them newest first; click one to reopen it, × to remove it. On load, the latest one opens, or the demo if there are none.
- **Save PNG** renders the flat sticker at texture resolution with a transparent background.

## Gotchas

- Every remapped sample uses `textureLod` with a precomputed level (`gLod`). Implicit-derivative `texture()` calls inside the peel branches drew hairlines across the table.
- Use `sq(x)`, not `pow(x, 2.0)`: `pow` is undefined for negative bases.
- The sticker texture's padding must stay wider than the angular facets can push out. Otherwise clamp-to-edge smears the edge texels into lines when the flap is remapped. `inBox` also guards against this.
