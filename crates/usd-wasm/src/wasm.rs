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
        // Textures inside a USDZ cannot be fetched by URL: keep their packages,
        // to read only the images the texture mode loads, each once.
        let packages = self.inner.take_texture_packages(&scene);
        self.inner.clear();
        Ok(UsdScene { scene, current: None, packages })
    }
}

impl Default for UsdLoader {
    fn default() -> Self {
        Self::new()
    }
}

/// A composed scene whose meshes are read one at a time: `read(i)` makes
/// geometry `i` current, and the array getters move its data out (each once).
/// Only the current mesh's arrays live in WASM memory at any time.
#[wasm_bindgen]
pub struct UsdScene {
    scene: Scene,
    current: Option<crate::extract::Geometry>,
    packages: std::collections::HashMap<String, Vec<u8>>,
}

#[wasm_bindgen]
impl UsdScene {
    /// Everything but the triangle data, as JSON.
    pub fn meta(&self) -> String {
        crate::json::scene_meta(&self.scene)
    }

    /// Reads geometry `index` and returns its metadata as JSON, or `None` when
    /// the mesh has nothing drawable.
    pub fn read(&mut self, index: usize) -> Result<Option<String>, JsError> {
        self.current = self.scene.read_geometry(index).map_err(js_error)?;
        Ok(self.current.as_ref().map(crate::json::geometry_meta))
    }

    /// Releases the stage once every geometry has been read.
    pub fn finish(&mut self) {
        self.current = None;
        self.scene.sources.clear();
    }

    pub fn positions(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.geometry().positions)
    }

    pub fn normals(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.geometry().normals)
    }

    /// UV set `set` (in the order of the geometry's `uvSets`).
    pub fn uvs(&mut self, set: usize) -> Vec<f32> {
        std::mem::take(&mut self.geometry().uvs[set].1)
    }

    pub fn colors(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.geometry().colors)
    }

    pub fn indices(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.geometry().indices)
    }

    /// Indices as 16-bit, for geometries with fewer than 65536 vertices.
    pub fn indices16(&mut self) -> Vec<u16> {
        let indices = std::mem::take(&mut self.geometry().indices);
        indices.into_iter().map(|i| i as u16).collect()
    }

    /// A texture that lives inside a USDZ package, if `path` names one there.
    #[wasm_bindgen(js_name = packagedFile)]
    pub fn packaged_file(&self, path: &str) -> Result<Option<Vec<u8>>, JsError> {
        let Some((package, inner)) = resolver::split_packaged(path) else {
            return Ok(None);
        };
        let Some(bytes) = self.packages.get(package) else {
            return Ok(None);
        };
        match resolver::read_packaged(bytes, inner, resolver::MAX_PACKAGED_FILE_BYTES) {
            Ok(file) => Ok(Some(file)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(js_error(e)),
        }
    }

    fn geometry(&mut self) -> &mut crate::extract::Geometry {
        self.current.as_mut().expect("read a geometry first")
    }
}
