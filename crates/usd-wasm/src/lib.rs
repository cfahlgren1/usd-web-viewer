//! OpenUSD composition and mesh extraction for web viewers.
//!
//! The host fetches layers, hands them to a [`Loader`], fetches whatever the
//! loader reports missing, and finally composes and extracts a [`Scene`].

use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet};
use std::rc::Rc;

use openusd::{sdf, usd};

pub mod deps;
pub mod extract;
pub mod json;
pub mod material;
pub mod resolver;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use deps::Dependency;
pub use extract::Scene;
use resolver::{Files, MemoryResolver};

#[derive(Default)]
pub struct Loader {
    files: Files,
    /// Layers the host could not fetch; composition goes on without them.
    unavailable: HashSet<String>,
}

/// What [`Loader::compose`] produced: a scene, or the layers it still needs.
pub enum Composed {
    Scene(Scene),
    Missing(Vec<String>),
}

impl Loader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has(&self, path: &str) -> bool {
        resolver::lock(&self.files).bytes.contains_key(path)
    }

    /// Stores a layer under its virtual path and returns the asset paths it
    /// authors, so the host can prefetch them in parallel.
    pub fn add_layer(&mut self, path: &str, bytes: Vec<u8>) -> openusd::Result<Vec<Dependency>> {
        resolver::lock(&self.files).bytes.insert(path.to_owned(), bytes);
        let layer = sdf::Layer::open_with(self.resolver(false, None), path)?;
        let real_path = layer.resolved_path().unwrap_or(path).to_owned();
        let mut deps = deps::layer_dependencies(layer.data(), &real_path);
        // Files inside a package we hold need no fetching.
        let files = resolver::lock(&self.files);
        deps.retain(|d| resolver::split_packaged(&d.path).is_none_or(|(package, _)| !files.bytes.contains_key(package)));
        // Arcs to formats nothing here reads (MaterialX) are not worth fetching.
        deps.retain(|d| !d.arc || resolver::is_layer_path(&d.path));
        Ok(deps)
    }

    /// Records a layer the host failed to fetch, so `compose` stops asking.
    pub fn mark_unavailable(&mut self, path: &str) {
        self.unavailable.insert(path.to_owned());
    }

    /// Composes the stage rooted at `root`. When composition asks for layers
    /// that were never added, returns them instead so the host can fetch them
    /// and call again. The stage takes ownership of the layer bytes, so the
    /// returned list also names the layers this attempt consumed: the host
    /// adds those again too (normally from its HTTP cache).
    pub fn compose(&self, root: &str) -> openusd::Result<Composed> {
        let resolver = self.resolver(true, Some(root));
        let missing = resolver.missing.clone();
        let stage = usd::Stage::builder()
            .resolver(resolver)
            .schema_registry(openusd_schemas::schema_registry())
            .open(root)?;
        // Composition opens references and payloads lazily: walk the whole
        // stage first so every layer it needs is asked for before extracting.
        stage.traverse(usd::PrimPredicate::DEFAULT_PROXIES, |_| {})?;
        let mut missing: Vec<String> = missing
            .borrow()
            .iter()
            .filter(|m| !self.unavailable.contains(*m))
            .cloned()
            .collect();
        let taken = std::mem::take(&mut resolver::lock(&self.files).taken);
        if !missing.is_empty() {
            missing.extend(taken);
            return Ok(Composed::Missing(missing));
        }
        Ok(Composed::Scene(extract::extract(&stage)?))
    }

    /// A file inside a stored USDZ package (`/h/pkg.usdz[tex.png]`), e.g. a texture.
    pub fn packaged_file(&self, path: &str) -> Option<Vec<u8>> {
        let (package, inner) = resolver::split_packaged(path)?;
        let files = resolver::lock(&self.files);
        resolver::read_packaged(files.bytes.get(package)?, inner)
    }

    /// Drops every stored layer.
    pub fn clear(&mut self) {
        resolver::lock(&self.files).bytes.clear();
    }

    fn resolver(&self, take: bool, keep: Option<&str>) -> MemoryResolver {
        MemoryResolver {
            files: self.files.clone(),
            missing: Rc::new(RefCell::new(BTreeSet::new())),
            take,
            keep: RefCell::new(keep.map(str::to_owned)),
        }
    }
}
