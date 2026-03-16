function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var secret = PropertiesService.getScriptProperties().getProperty('ARCHIVE_SECRET') || '';

    if (secret) {
      if (payload.shared_secret !== secret) {
        return jsonResponse_(401, { error: 'Unauthorized' });
      }
    }

    var rootFolderId = PropertiesService.getScriptProperties().getProperty('HR_ROOT_FOLDER_ID');
    if (!rootFolderId) {
      return jsonResponse_(500, { error: 'HR_ROOT_FOLDER_ID is not configured' });
    }

    validatePayload_(payload);

    var rootFolder = DriveApp.getFolderById(rootFolderId);
    var employeeFolder = getOrCreateFolder_(rootFolder, 'Employees');
    employeeFolder = getOrCreateFolder_(employeeFolder, payload.archive_paths.employeeFolder);
    employeeFolder = getOrCreateFolder_(employeeFolder, 'Performance Reviews');
    employeeFolder = getOrCreateFolder_(employeeFolder, payload.archive_paths.cycleFolder);

    var cycleFolder = getOrCreateFolder_(rootFolder, payload.archive_paths.cycleFolder);
    cycleFolder = getOrCreateFolder_(cycleFolder, archiveTypeFolder_(payload.document_type));

    var employeeFile = upsertTextFile_(employeeFolder, payload.archive_paths.fileName, payload.content);
    upsertTextFile_(cycleFolder, payload.archive_paths.fileName, payload.content);

    return jsonResponse_(200, {
      archiveUrl: employeeFile.getUrl(),
      archiveKey: employeeFile.getId()
    });
  } catch (error) {
    return jsonResponse_(500, {
      error: String(error)
    });
  }
}

function validatePayload_(payload) {
  if (!payload.document_type) throw new Error('document_type is required');
  if (!payload.title) throw new Error('title is required');
  if (!payload.content) throw new Error('content is required');
  if (!payload.cycle_name) throw new Error('cycle_name is required');
  if (!payload.employee_name) throw new Error('employee_name is required');
  if (!payload.archive_paths) throw new Error('archive_paths is required');
  if (!payload.archive_paths.employeeFolder) throw new Error('archive_paths.employeeFolder is required');
  if (!payload.archive_paths.cycleFolder) throw new Error('archive_paths.cycleFolder is required');
  if (!payload.archive_paths.fileName) throw new Error('archive_paths.fileName is required');
}

function archiveTypeFolder_(documentType) {
  if (documentType === 'manager_review') return 'Manager Reviews';
  if (documentType === 'peer_feedback') return 'Peer Feedback';
  if (documentType === 'upward_feedback') return 'Upward Feedback';
  return 'Documents';
}

function getOrCreateFolder_(parent, name) {
  var folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

function upsertTextFile_(folder, fileName, content) {
  var files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    var existing = files.next();
    existing.setContent(content);
    return existing;
  }
  return folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
}

function jsonResponse_(status, body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}
