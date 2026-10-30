use std::io::{Read, Write};
use std::path::Path;
pub const MAX_BACKUP_BYTES: u64 = 5 * 1024 * 1024;
pub fn read_backup(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Unable to open this backup: {e}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_BACKUP_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Unable to read this backup: {e}"))?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err("Choose a backup smaller than 5 MB.".into());
    }
    String::from_utf8(bytes).map_err(|_| "This backup is not valid UTF-8 text.".into())
}
pub fn write_backup(path: &Path, content: &str) -> Result<(), String> {
    if content.len() as u64 > MAX_BACKUP_BYTES {
        return Err("This backup exceeds 5 MB.".into());
    }
    let parent = path.parent().ok_or("Choose a valid backup location.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("Unable to create this backup: {e}"))?;
    temp.write_all(content.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("Unable to write this backup: {e}"))?;
    temp.persist(path)
        .map_err(|e| format!("Unable to finish saving this backup: {e}"))?;
    Ok(())
}
pub fn prepare_backup_folder(app_data: &Path) -> Result<std::path::PathBuf, String> {
    // Check every component so a symlinked ancestor cannot redirect Finder.
    for ancestor in app_data.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)
            .map_err(|_| "Unable to inspect app data folder.".to_owned())?;
        if !metadata.file_type().is_dir() {
            return Err("The app data folder is not a regular directory.".into());
        }
    }
    let folder = app_data.join("backups");
    match std::fs::symlink_metadata(&folder) {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err("The backup folder is not a regular directory.".into())
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&folder)
            .map_err(|_| "Unable to create backup folder.".to_owned())?,
        Err(_) => return Err("Unable to inspect backup folder.".into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Unable to protect backup folder.".to_owned())?;
        for path in [app_data, folder.as_path()] {
            std::fs::File::open(path)
                .and_then(|file| file.sync_all())
                .map_err(|_| "Unable to sync backup folder.".to_owned())?;
        }
    }
    Ok(folder)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finder_folder_is_private_and_rejects_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let folder = prepare_backup_folder(&root).unwrap();
        assert_eq!(folder, root.join("backups"));
        assert!(folder.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(
                std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
                0o700
            );
            let other = tempfile::tempdir().unwrap();
            symlink(&folder, other.path().join("backups")).unwrap();
            assert!(prepare_backup_folder(&other.path().canonicalize().unwrap()).is_err());
            let alias = root.join("alias");
            symlink(other.path(), &alias).unwrap();
            assert!(prepare_backup_folder(&alias).is_err());
        }
    }
    #[test]
    fn backup_round_trip_and_bounded_input() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.json");
        let content = "{\"version\":1,\"note\":\"数学\"}";
        write_backup(&path, content).unwrap();
        assert_eq!(read_backup(&path).unwrap(), content);
        std::fs::write(&path, vec![b' '; MAX_BACKUP_BYTES as usize + 1]).unwrap();
        assert!(read_backup(&path).is_err());
    }
    #[test]
    fn failed_export_does_not_claim_success_or_damage_previous_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.json");
        std::fs::write(&path, "old").unwrap();
        assert!(write_backup(&path, &"x".repeat(MAX_BACKUP_BYTES as usize + 1)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        assert!(write_backup(&dir.path().join("missing").join("backup.json"), "new").is_err());
    }
}
