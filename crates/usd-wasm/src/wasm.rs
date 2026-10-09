//! The JavaScript surface, used from a Web Worker.

use wasm_bindgen::prelude::*;

use crate::{Composed, Loader, Scene, resolver};

fn js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

#[wasm_bindgen]
pub struct UsdLoader {
    inner: Loader,
    scene: Option<Scene>,
}

#[wasm_bindgen]
impl UsdLoader {
    #[wasm_bindgen(constructor)]
    pub fn new() -> UsdLoader {
        UsdLoader {
            inner: Loader::new(),
            scene: None,
        }
    }

    pub fn has(&self, path: &str) -> bool {
        self.inner.has(path)
    }

    /// Stores a layer and returns the asset paths it authors, each prefixed
    /// with a kind: `L` a layer arc, `V` a layer arc inside a variant, `A` any
    /// other asset.
    #[wasm_bindgen(js_name = addLayer)]
    pub fn add_layer(&mut self, path: &str, bytes: Vec<u8>) -> Result<Vec<String>, JsError> {
        let deps = self.inner.add_layer(path, bytes).map_err(js_error)?;
        Ok(deps
            .into_iter()
            .map(|d| {
                let kind = match (d.arc, d.in_variant) {
                    (true, false) => 'L',
                    (true, true) => 'V',
                    (false, _) => 'A',
                };
                format!("{kind}{}", d.path)
            })
            .collect())
    }

    #[wasm_bindgen(js_name = markUnavailable)]
    pub fn mark_unavailable(&mut self, path: &str) {
        self.inner.mark_unavailable(path);
    }

    /// Composes the stage at `root`. Returns the layers still missing; when
    /// that is empty the scene is ready for [`take_scene`](Self::take_scene).
    pub fn compose(&mut self, root: &str) -> Result<Vec<String>, JsError> {
        match self.inner.compose(root).map_err(js_error)? {
            Composed::Missing(missing) => Ok(missing),
            Composed::Scene(scene) => {
                self.scene = Some(scene);
                Ok(Vec::new())
            }
        }
    }

    /// Hands over the extracted scene and drops every stored layer.
    #[wasm_bindgen(js_name = takeScene)]
    pub fn take_scene(&mut self) -> Result<UsdScene, JsError> {
        let scene = self.scene.take().ok_or_else(|| JsError::new("compose has not produced a scene"))?;
        // Textures inside a USDZ cannot be fetched by URL: pull them out
        // before the package bytes are dropped.
        let mut packaged = std::collections::HashMap::new();
        for m in &scene.materials {
            for (_, t) in &m.maps {
                if resolver::split_packaged(&t.path).is_none() {
                    continue;
                }
                match self.inner.packaged_file(&t.path) {
                    Ok(bytes) => {
                        packaged.insert(t.path.clone(), bytes);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(js_error(e)),
                }
            }
        }
        self.inner.clear();
        Ok(UsdScene { scene, packaged })
    }
}

impl Default for UsdLoader {
    fn default() -> Self {
        Self::new()
    }
}

/// An extracted scene. Array getters move the data out, so each is read once.
#[wasm_bindgen]
pub struct UsdScene {
    scene: Scene,
    packaged: std::collections::HashMap<String, Vec<u8>>,
}

#[wasm_bindgen]
impl UsdScene {
    /// Everything but the bulk arrays, as JSON.
    pub fn meta(&self) -> String {
        crate::json::scene_meta(&self.scene)
    }

    pub fn positions(&mut self, geometry: usize) -> Vec<f32> {
        std::mem::take(&mut self.scene.geometries[geometry].positions)
    }

    pub fn normals(&mut self, geometry: usize) -> Vec<f32> {
        std::mem::take(&mut self.scene.geometries[geometry].normals)
    }

    /// UV set `set` (in the order of the geometry's `uvSets`).
    pub fn uvs(&mut self, geometry: usize, set: usize) -> Vec<f32> {
        std::mem::take(&mut self.scene.geometries[geometry].uvs[set].1)
    }

    pub fn colors(&mut self, geometry: usize) -> Vec<f32> {
        std::mem::take(&mut self.scene.geometries[geometry].colors)
    }

    pub fn indices(&mut self, geometry: usize) -> Vec<u32> {
        std::mem::take(&mut self.scene.geometries[geometry].indices)
    }

    /// A texture that lives inside a USDZ package, if `path` names one.
    #[wasm_bindgen(js_name = packagedFile)]
    pub fn packaged_file(&mut self, path: &str) -> Option<Vec<u8>> {
        self.packaged.remove(path)
    }

    /// Indices as 16-bit, for geometries with fewer than 65536 vertices.
    pub fn indices16(&mut self, geometry: usize) -> Vec<u16> {
        let indices = std::mem::take(&mut self.scene.geometries[geometry].indices);
        indices.into_iter().map(|i| i as u16).collect()
    }
}
