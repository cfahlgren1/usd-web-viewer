//! An in-memory asset resolver over "virtual paths".
//!
//! The browser side maps every URL to a virtual absolute path (`/<host>/<path>`)
//! so relative asset paths can be anchored with plain POSIX rules here, and
//! maps them back to URLs when it fetches. Layers live in a shared map filled
//! before composition; nothing is ever read from a filesystem or network.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::io::{self, Read, Seek, SeekFrom};
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard};

use openusd::ar::{self, Asset, ResolvedPath};

/// Layer bytes shared between the loader and its resolvers.
pub type Files = Arc<Mutex<Store>>;

/// Extensions composition reads as layers. Anything else (textures, MDL) is
/// an opaque asset that resolves without being present.
pub fn is_layer_path(path: &str) -> bool {
    matches!(extension(path).as_str(), "usd" | "usda" | "usdc" | "usdz")
}

fn extension(path: &str) -> String {
    let path = path.strip_suffix(']').unwrap_or(path);
    let name = path.rsplit(['/', '[']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Splits a package-relative path `pkg.usdz[inner]` into its package and the
/// path inside it. Nested packages are not supported.
pub fn split_packaged(path: &str) -> Option<(&str, &str)> {
    let inner = path.strip_suffix(']')?;
    let open = inner.find('[')?;
    Some((&inner[..open], &inner[open + 1..]))
}

/// Turns an authored asset path into a virtual path, anchored at the virtual
/// path of the layer that authored it. Returns `None` for empty paths. Paths
/// authored inside a USDZ package stay inside it (`/h/pkg.usdz[tex/a.png]`).
pub fn anchor_path(asset_path: &str, anchor: Option<&str>) -> Option<String> {
    let path = asset_path.trim().replace('\\', "/");
    if path.is_empty() {
        return None;
    }
    if let Some((package, inner)) = split_packaged(&path) {
        let package = anchor_path(package, anchor)?;
        return Some(format!("{package}[{}]", &normalize(inner)[1..]));
    }
    if let Some(rest) = path.strip_prefix("https://").or_else(|| path.strip_prefix("http://")) {
        return Some(normalize(&format!("/{rest}")));
    }
    if let Some(rest) = path.strip_prefix("file://") {
        return Some(normalize(rest));
    }
    if path.starts_with('/') {
        return Some(normalize(&path));
    }
    if let Some(anchor) = anchor {
        if let Some((package, inner)) = split_packaged(anchor) {
            let dir = inner.rsplit_once('/').map_or("", |(dir, _)| dir);
            return Some(format!("{package}[{}]", &normalize(&format!("{dir}/{path}"))[1..]));
        }
        if extension(anchor) == "usdz" {
            return Some(format!("{anchor}[{}]", &normalize(&path)[1..]));
        }
    }
    let dir = match anchor {
        Some(anchor) => anchor.rsplit_once('/').map_or("", |(dir, _)| dir),
        None => "",
    };
    Some(normalize(&format!("{dir}/{path}")))
}

/// Most bytes one file inside a package may expand to.
pub const MAX_PACKAGED_FILE_BYTES: u64 = 1 << 30;
/// Most bytes all package reads during one composition may expand to.
pub const MAX_PACKAGED_TOTAL_BYTES: u64 = 2 << 30;

/// Reads one file out of a USDZ (zip) package held in memory, refusing to
/// expand it past `limit` bytes. Zip headers are untrusted: the declared size
/// only sizes the buffer up to the package's own length.
pub fn read_packaged(package: &[u8], inner: &str, limit: u64) -> io::Result<Vec<u8>> {
    let mut archive = zip::ZipArchive::new(io::Cursor::new(package)).map_err(io::Error::other)?;
    let entry = archive
        .by_name(inner)
        .map_err(|e| io::Error::new(io::ErrorKind::NotFound, e))?;
    let mut out = Vec::with_capacity(entry.size().min(package.len() as u64) as usize);
    entry.take(limit + 1).read_to_end(&mut out)?;
    if out.len() as u64 > limit {
        return Err(io::Error::other(format!(
            "resource limit exceeded: {inner} expands past {limit} bytes"
        )));
    }
    Ok(out)
}

/// Collapses `.`, `..` and repeated separators, and drops a query string.
fn normalize(path: &str) -> String {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Fetched layers by virtual path.
#[derive(Default)]
pub struct Store {
    /// Bytes not yet handed to a composing stage.
    pub bytes: HashMap<String, Vec<u8>>,
    /// Layers a composing stage took ownership of: present for this stage,
    /// gone for any later one.
    pub taken: Vec<String>,
    /// Bytes package reads expanded to since the last composition began.
    pub expanded: u64,
}

impl Store {
    /// Reads a packaged file (`/h/pkg.usdz[inner]`) within the per-file and
    /// per-composition expansion limits.
    pub fn read_packaged(&mut self, path: &str) -> io::Result<Vec<u8>> {
        let not_found = || io::Error::new(io::ErrorKind::NotFound, path.to_owned());
        let (package, inner) = split_packaged(path).ok_or_else(not_found)?;
        let package = self.bytes.get(package).ok_or_else(not_found)?;
        let budget = MAX_PACKAGED_TOTAL_BYTES.saturating_sub(self.expanded);
        let bytes = read_packaged(package, inner, MAX_PACKAGED_FILE_BYTES.min(budget))?;
        self.expanded += bytes.len() as u64;
        Ok(bytes)
    }
}

/// Resolves virtual paths against the [`Store`], recording every layer that
/// was asked for but is not there yet so the caller can fetch it and recompose.
pub struct MemoryResolver {
    pub files: Files,
    pub missing: Rc<RefCell<BTreeSet<String>>>,
    /// Move bytes into the stage instead of copying them, so a layer is held
    /// once (by the stage) rather than twice while composing.
    pub take: bool,
    /// A layer copied rather than taken the first time it is opened: opening a
    /// stage reads its root layer twice.
    pub keep: RefCell<Option<String>>,
}

impl ar::Resolver for MemoryResolver {
    fn create_identifier(&self, asset_path: &str, anchor: Option<&ResolvedPath>) -> String {
        let anchor = anchor.map(|a| a.to_string_lossy().into_owned());
        anchor_path(asset_path, anchor.as_deref()).unwrap_or_default()
    }

    fn resolve(&self, asset_path: &str) -> Option<ResolvedPath> {
        if asset_path.is_empty() {
            return None;
        }
        let key = split_packaged(asset_path).map_or(asset_path, |(package, _)| package);
        let present = {
            let files = lock(&self.files);
            files.bytes.contains_key(key) || (self.take && files.taken.iter().any(|t| t == key))
        };
        // MaterialX documents are only ever referenced as layers, and no format
        // here reads them: leave them unresolved so composition goes on without.
        if extension(asset_path) == "mtlx" {
            return None;
        }
        if !is_layer_path(asset_path) || present {
            return Some(ResolvedPath::new(asset_path));
        }
        self.missing.borrow_mut().insert(key.to_owned());
        None
    }

    fn resolve_for_new_asset(&self, asset_path: &str) -> Option<ResolvedPath> {
        Some(ResolvedPath::new(asset_path))
    }

    fn open_asset(&self, resolved_path: &ResolvedPath) -> io::Result<Box<dyn Asset>> {
        let key = resolved_path.to_string_lossy().into_owned();
        if split_packaged(&key).is_some() {
            let bytes = lock(&self.files).read_packaged(&key)?;
            return Ok(Box::new(MemAsset(io::Cursor::new(bytes))));
        }
        let first_root_read = self.keep.borrow().as_deref() == Some(key.as_str());
        if first_root_read {
            self.keep.replace(None);
        }
        // A package is read entry by entry, so it stays in the store.
        let take = self.take && !first_root_read && extension(&key) != "usdz";
        let size = match lock(&self.files).bytes.get(&key) {
            Some(bytes) => bytes.len() as u64,
            None => return Err(io::Error::new(io::ErrorKind::NotFound, key)),
        };
        Ok(Box::new(StoredAsset {
            files: self.files.clone(),
            key,
            size,
            pos: 0,
            take,
        }))
    }

    fn get_modification_timestamp(&self, _: &str, _: &ResolvedPath) -> Option<std::time::SystemTime> {
        None
    }

    fn identity(&self) -> String {
        "usd-wasm-memory".to_owned()
    }
}

/// An extracted package entry.
struct MemAsset(io::Cursor<Vec<u8>>);

impl Read for MemAsset {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Seek for MemAsset {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.0.seek(pos)
    }
}

impl Asset for MemAsset {
    fn size(&self) -> io::Result<u64> {
        Ok(self.0.get_ref().len() as u64)
    }

    fn read_all(&mut self) -> io::Result<Vec<u8>> {
        if self.0.position() == 0 {
            return Ok(std::mem::take(self.0.get_mut()));
        }
        let mut rest = Vec::new();
        self.0.read_to_end(&mut rest)?;
        Ok(rest)
    }
}

pub(crate) fn lock(files: &Files) -> MutexGuard<'_, Store> {
    files.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A layer in the [`Store`], read in place. A full read in take mode moves
/// the buffer out of the store instead of copying it: format sniffing opens a
/// layer more than once, so ownership moves only when it is read whole.
struct StoredAsset {
    files: Files,
    key: String,
    size: u64,
    pos: u64,
    take: bool,
}

impl Read for StoredAsset {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let files = lock(&self.files);
        let Some(bytes) = files.bytes.get(&self.key) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, self.key.clone()));
        };
        let start = (self.pos as usize).min(bytes.len());
        let n = buf.len().min(bytes.len() - start);
        buf[..n].copy_from_slice(&bytes[start..start + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for StoredAsset {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.size as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

impl Asset for StoredAsset {
    fn size(&self) -> io::Result<u64> {
        Ok(self.size)
    }

    fn read_all(&mut self) -> io::Result<Vec<u8>> {
        if self.pos != 0 {
            let mut rest = Vec::new();
            self.read_to_end(&mut rest)?;
            return Ok(rest);
        }
        let mut files = lock(&self.files);
        let bytes = if self.take {
            let bytes = files.bytes.remove(&self.key);
            if bytes.is_some() {
                files.taken.push(self.key.clone());
            }
            bytes
        } else {
            files.bytes.get(&self.key).cloned()
        };
        self.pos = self.size;
        bytes.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, self.key.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_relative_paths() {
        let root = "/huggingface.co/datasets/a/b/resolve/main/x/root.usd";
        assert_eq!(
            anchor_path("./payloads/base.usda", Some(root)).unwrap(),
            "/huggingface.co/datasets/a/b/resolve/main/x/payloads/base.usda"
        );
        assert_eq!(
            anchor_path("../tex/a.png", Some(root)).unwrap(),
            "/huggingface.co/datasets/a/b/resolve/main/tex/a.png"
        );
        assert_eq!(
            anchor_path("https://cdn.example/a/b.usd?x=1", Some(root)).unwrap(),
            "/cdn.example/a/b.usd"
        );
        assert_eq!(anchor_path("SubUSDs\\textures\\t.jpg", Some("/h/r.usd")).unwrap(), "/h/SubUSDs/textures/t.jpg");
        assert_eq!(anchor_path("tex/a.png", Some("/h/p.usdz[root.usdc]")).unwrap(), "/h/p.usdz[tex/a.png]");
        assert_eq!(anchor_path("a.usdc", Some("/h/p.usdz")).unwrap(), "/h/p.usdz[a.usdc]");
        assert_eq!(anchor_path("./p.usdz[x/y.usd]", Some("/h/r.usda")).unwrap(), "/h/p.usdz[x/y.usd]");
        assert!(is_layer_path("/h/p.usdz[x/y.usdc]"));
        assert_eq!(anchor_path("tex/a.png", Some("/h/p.usdz[root.usdc]")).unwrap(), "/h/p.usdz[tex/a.png]");
        assert_eq!(anchor_path("a.usdc", Some("/h/p.usdz")).unwrap(), "/h/p.usdz[a.usdc]");
        assert_eq!(anchor_path("./p.usdz[x/y.usd]", Some("/h/r.usda")).unwrap(), "/h/p.usdz[x/y.usd]");
        assert!(is_layer_path("/h/p.usdz[x/y.usdc]"));
    }

    /// A package with one deflated entry of `size` zero bytes.
    fn zeros_package(size: usize) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("big.usdc", options).unwrap();
        io::Write::write_all(&mut zip, &vec![0; size]).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn packaged_file_expanding_past_the_limit_is_refused() {
        let package = zeros_package(1 << 20);
        assert!(package.len() < 4096, "a decompression bomb");
        let error = read_packaged(&package, "big.usdc", 1 << 16).unwrap_err();
        assert!(error.to_string().contains("resource limit exceeded"), "{error}");
        assert_eq!(read_packaged(&package, "big.usdc", 1 << 20).unwrap().len(), 1 << 20);
    }

    #[test]
    fn packaged_files_share_one_expansion_budget() {
        let mut store = Store::default();
        store.bytes.insert("/h/p.usdz".to_owned(), zeros_package(100));
        store.expanded = MAX_PACKAGED_TOTAL_BYTES - 150;
        assert_eq!(store.read_packaged("/h/p.usdz[big.usdc]").unwrap().len(), 100);
        let error = store.read_packaged("/h/p.usdz[big.usdc]").unwrap_err();
        assert!(error.to_string().contains("resource limit exceeded"), "{error}");
    }
}
