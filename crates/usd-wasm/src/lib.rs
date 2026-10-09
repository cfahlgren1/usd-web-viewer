//! OpenUSD composition and mesh extraction for web viewers.
//!
//! The host fetches layers, hands them to a [`Loader`], fetches whatever the
//! loader reports missing, and finally composes and extracts a [`Scene`].

use std::cell::RefCell;
use std::collections::{BTreeSet, HashSet};
use std::rc::Rc;
use std::sync::Arc;

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
        self.files.borrow().contains_key(path)
    }

    /// Stores a layer under its virtual path and returns the asset paths it
    /// authors, so the host can prefetch them in parallel.
    pub fn add_layer(&mut self, path: &str, bytes: Vec<u8>) -> openusd::Result<Vec<Dependency>> {
        self.files.borrow_mut().insert(path.to_owned(), Arc::new(bytes));
        let layer = sdf::Layer::open_with(self.resolver(), path)?;
        Ok(deps::layer_dependencies(layer.data(), path))
    }

    /// Records a layer the host failed to fetch, so `compose` stops asking.
    pub fn mark_unavailable(&mut self, path: &str) {
        self.unavailable.insert(path.to_owned());
    }

    /// Composes the stage rooted at `root`. When composition asks for layers
    /// that were never added, returns them instead so the host can fetch them
    /// and call again.
    pub fn compose(&self, root: &str) -> openusd::Result<Composed> {
        let resolver = self.resolver();
        let missing = resolver.missing.clone();
        let stage = usd::Stage::builder()
            .resolver(resolver)
            .schema_registry(openusd_schemas::schema_registry())
            .open(root)?;
        // Composition opens references and payloads lazily: walk the whole
        // stage first so every layer it needs is asked for before extracting.
        stage.traverse(usd::PrimPredicate::DEFAULT_PROXIES, |_| {})?;
        let missing: Vec<String> = missing
            .borrow()
            .iter()
            .filter(|m| !self.unavailable.contains(*m))
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Ok(Composed::Missing(missing));
        }
        Ok(Composed::Scene(extract::extract(&stage)?))
    }

    /// Drops every stored layer.
    pub fn clear(&mut self) {
        self.files.borrow_mut().clear();
    }

    fn resolver(&self) -> MemoryResolver {
        MemoryResolver {
            files: self.files.clone(),
            missing: Rc::new(RefCell::new(BTreeSet::new())),
        }
    }
}
