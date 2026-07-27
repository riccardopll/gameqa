# Optional threejsassets.com model

The FPS works from a clean checkout using a procedural barrel fallback.

To use the intended authored prop:

1. Sign in at https://threejsassets.com/assets/barrel-01.
2. Download **Barrel 01** under its Free Commercial License.
3. Place the downloaded file beside this README as `barrel-01.glb`.
4. Copy the matching Three.js Draco decoder files into `packages/demo-fps/public/draco/`:

   ```bash
   mkdir -p packages/demo-fps/public/draco
   cp -R node_modules/.pnpm/three@*/node_modules/three/examples/jsm/libs/draco/gltf/. packages/demo-fps/public/draco/
   ```

5. Start or rebuild the demo. The HUD reports whether the authored or procedural prop loaded.

The GLB is intentionally ignored by Git. threejsassets.com requires an account for free downloads and its license does not allow this repository to redistribute the standalone asset file. See https://threejsassets.com/license#free-asset-license and https://docs.threejsassets.com/getting-started/quickstart.
