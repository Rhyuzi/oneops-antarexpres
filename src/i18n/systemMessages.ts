/**
 * Display-time localization of messages that originate outside the UI:
 * API error/success messages (server/), rechecker worker results and Excel
 * parser errors. Those stay in their original English form in state, data,
 * logs and audit records; only what is RENDERED is translated, so switching
 * language also re-translates messages already on screen.
 *
 * Exact messages map to a key; messages with dynamic parts use a pattern.
 * Unknown messages are returned unchanged (never dropped).
 */
import { t, type MessageKey, type MessageParams } from './index'
import { en } from './locales/en'

const EXACT: Record<string, MessageKey> = {
  'A file with that name already exists in the target folder': 'errors.server.fileExistsTarget',
  'A file with that name already exists in this folder': 'errors.server.fileExistsHere',
  'A folder with that name already exists here': 'errors.server.folderExistsHere',
  'A role with that name already exists': 'errors.server.roleExists',
  'A valid email address is required': 'errors.server.validEmailRequired',
  'A valid recipient email is required': 'errors.server.validRecipientRequired',
  'Account activated. You can now sign in': 'errors.server.accountActivatedSignIn',
  'Account has no email address on file': 'errors.server.accountNoEmail',
  'Account has not been activated yet — resend the invitation instead': 'errors.server.accountNotActivatedResend',
  'Account not found': 'errors.server.accountNotFound',
  'At least one role is required': 'errors.server.atLeastOneRole',
  'Audit record not found': 'errors.server.auditRecordNotFound',
  'Audit records are read-only': 'errors.server.auditReadOnly',
  'Authentication required': 'errors.server.authRequired',
  'Cannot deactivate the last active Super Admin account': 'errors.server.lastSuperAdminDeactivate',
  'Cannot delete the last active Super Admin account': 'errors.server.lastSuperAdminDelete',
  'Cannot move a folder into itself or its own subfolder': 'errors.server.folderIntoItself',
  "Cannot remove the last Super Admin's administrative access": 'errors.server.lastSuperAdminRemove',
  'Database unavailable': 'errors.server.databaseUnavailable',
  'Database is not configured': 'errors.server.databaseUnavailable',
  'Duplicate role in payload': 'errors.server.duplicateRolePayload',
  'File not found': 'errors.server.fileNotFound',
  'File storage is not available. Try again later': 'errors.server.storageUnavailableRetry',
  'File storage is not available': 'errors.server.storageUnavailable',
  'Files cannot be moved to the virtual root': 'errors.server.filesNotToRoot',
  'Folder name must be 1–191 characters without line breaks': 'errors.server.folderNameInvalid',
  'Folder not found': 'errors.server.folderNotFound',
  'Full name must be 2–150 characters': 'errors.server.fullNameLength',
  'If that email address belongs to an account, a reset link has been sent': 'errors.server.resetLinkGeneric',
  'Insufficient permissions': 'errors.server.insufficientPermissions',
  'Invalid JSON body': 'errors.server.invalidJson',
  'Invalid file name': 'errors.server.invalidFileName',
  'Invalid file size': 'errors.server.invalidFileSize',
  'Invalid upload token': 'errors.server.invalidUploadToken',
  'Invalid username or password': 'errors.server.invalidCredentials',
  'Login is disabled: SESSION_SECRET is not configured on the server': 'errors.server.loginDisabled',
  'Malformed upload token': 'errors.server.malformedUploadToken',
  'Missing AWB number': 'errors.server.missingAwb',
  'Missing SiCepat credentials. Configure them in Settings': 'errors.server.missingSicepatCredentials',
  'Not found': 'errors.server.notFound',
  'Only Super Admin can create root folders': 'errors.server.onlySuperAdminRootFolders',
  'Only a Super Admin can assign the super_admin role': 'errors.server.onlySuperAdminAssign',
  'Only accounts pending activation can receive invitations': 'errors.server.onlyPendingInvitations',
  'Password updated. Please sign in with your new password': 'errors.server.passwordUpdatedSignIn',
  'Passwords do not match': 'errors.server.passwordsMismatch',
  'Permission system unavailable. Contact your administrator': 'errors.server.permissionSystemUnavailable',
  'Permission system is not initialized. Import database/migrations/007_create_role_permissions.sql first': 'errors.server.permissionSystemNotInitialized',
  'Permission lookup failed': 'errors.server.permissionSystemUnavailable',
  'Request body too large': 'errors.server.bodyTooLarge',
  'Role name must be 2–49 chars: lowercase letters, digits, underscores, starting with a letter': 'errors.server.roleNameInvalid',
  'Role not found': 'errors.server.roleNotFound',
  'Server error': 'errors.server.serverError',
  'Service unavailable': 'errors.server.serviceUnavailable',
  'Session signing unavailable': 'errors.server.sessionSigningUnavailable',
  'Choose a role to switch to': 'errors.server.chooseRole',
  'That role is not assigned to your account': 'errors.server.roleNotAssigned',
  'Only your name and email address can be changed here': 'errors.server.selfFieldsOnly',
  'Current and new password are required': 'errors.server.currentNewPwRequired',
  'The new password must be different from the current password': 'errors.server.newPwDifferent',
  'Account information updated': 'errors.server.accountInfoUpdated',
  'Current password is incorrect': 'errors.server.currentPwIncorrect',
  'Password changed. Your other sessions have been signed out': 'errors.server.pwChangedOthersSignedOut',
  'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD': 'errors.server.smtpNotConfigured',
  'Storage verification failed. Try again': 'errors.server.storageVerificationFailed',
  'Super Admin role required': 'errors.server.superAdminRequired',
  'Target folder does not exist': 'errors.server.targetFolderMissing',
  'That email address is already registered': 'errors.server.emailTaken',
  'That username is already taken': 'errors.server.usernameTaken',
  'Only a Super Admin can manage Data Warrior permissions': 'errors.server.superAdminOnlyPermissions',
  'Invalid parent folder': 'errors.server.invalidParentFolder',
  '`paths` array is required': 'errors.server.folderPathsRequired',
  'The super_admin role cannot be deactivated': 'errors.server.superAdminNoDeactivate',
  'The super_admin role cannot be deleted': 'errors.server.superAdminNoDelete',
  'The super_admin role cannot be renamed': 'errors.server.superAdminNoRename',
  'This account is already activated. Please sign in normally': 'errors.server.alreadyActivated',
  'This activation link is invalid, expired, or already used. Ask your administrator to resend the invitation': 'errors.server.activationLinkInvalid',
  'This reset link is invalid, expired, or already used. Request a new one': 'errors.server.resetLinkInvalid',
  'Token and password are required': 'errors.server.tokenAndPasswordRequired',
  'Too many requests. Try again later': 'errors.server.tooManyRequests',
  'Upload not found in storage — the file may have failed to upload. Try again': 'errors.server.uploadNotFound',
  'Upload token belongs to another user': 'errors.server.uploadTokenOtherUser',
  'Upload token expired — start again': 'errors.server.uploadTokenExpired',
  'Uploaded file size mismatch — upload rejected': 'errors.server.uploadSizeMismatch',
  'User not found': 'errors.server.userNotFound',
  'Username and password are required': 'errors.server.usernamePasswordRequired',
  'Username must be 3–64 characters: lowercase letters, digits, dot, underscore, dash': 'errors.server.usernameInvalid',
  "You cannot change your own account's roles. Ask another Super Admin": 'errors.server.cannotChangeOwnRoles',
  'You cannot deactivate your own account': 'errors.server.cannotDeactivateSelf',
  'You cannot delete your own account': 'errors.server.cannotDeleteSelf',
  'You do not have permission to perform this action': 'errors.server.noPermissionAction',
  'Your account has not been activated yet. Use the activation link from your invitation email': 'errors.server.notActivatedYet',
  '`permissions` array is required': 'errors.server.invalidRequest',
  '`roles` array (non-empty) is required': 'errors.server.invalidRequest',
  '`roles` array is required': 'errors.server.invalidRequest',
  'folderId is required (uploads to the virtual root are not allowed)': 'errors.server.invalidRequest',
  'uploadToken is required': 'errors.server.invalidRequest',
  'Start date is after end date': 'errors.server.startAfterEnd',
  'Account created, but SMTP is not configured — invitation not sent': 'errors.server.accountCreatedNoSmtp',
  'Could not load the audit trail': 'audit.loadFailed',
  // Kodepos loader (server/loader/*, server/routes/loader.js)
  'The 3PL template has no data rows': 'errors.server.loaderNoRows',
  'Both cust IDs (COD and Non-COD) are required': 'errors.server.loaderCustIdRequired',
  'Cust ID must be a number (digits only, max 15)': 'errors.server.loaderCustIdInvalid',
  'The COD and Non-COD cust IDs must be different': 'errors.server.loaderCustIdSame',
  'The kodepos reference (kebutuhan_loader) is empty. Import the master file first': 'errors.server.loaderReferenceEmpty',
  'The kodepos reference table is not installed. Run database/migrations/010_kebutuhan_loader.sql': 'errors.server.loaderTableMissing',
  'The loader could not process the files': 'errors.server.loaderFailed',
  'This download has expired. Process the files again': 'errors.server.loaderDownloadExpired',
  'No kecamatan/kodepos rows were found. Each sheet needs a header row: Kecamatan | Kode Pos': 'errors.server.loaderNoReferenceRows',
  'Method not allowed': 'errors.server.methodNotAllowed',
  'You already have a loader recheck job running. Wait for it to finish or cancel it': 'errors.server.loaderJobRunning',
  'The template did not pass the pre-check': 'errors.server.loaderPrecheckFailed',
  'Review the pre-check warnings and confirm to continue': 'errors.server.loaderPrecheckWarnings',
  'Loader job not found': 'errors.server.loaderJobNotFound',
  'Only paused jobs can be resumed': 'errors.server.loaderOnlyPausedResume',
  'This job can no longer be cancelled': 'errors.server.loaderJobNotCancellable',
  'Loader settings are not installed. Run database/migrations/011_loader_jobs_kota_wilayah.sql': 'errors.server.loaderSettingsMissing',
  'Kota_Tujuan must be at least 3 characters': 'errors.server.loaderKotaInvalid',
  'Unknown wilayah — it must exist in the kodepos reference': 'errors.server.loaderWilayahUnknown',
  'Mapping not found': 'errors.server.loaderMappingNotFound',
  // Master Data (server/masterData/*, routes/masterData.js)
  'HUB name must be at least 3 characters': 'errors.server.mdHubInvalid',
  'Analytic code may only contain letters and digits (max 30)': 'errors.server.mdAnalyticInvalid',
  'Wilayah is required': 'errors.server.mdWilayahRequired',
  'Kecamatan must be at least 2 characters': 'errors.server.mdKecamatanInvalid',
  'Kodepos must be 5 digits': 'errors.server.mdKodeposInvalid',
  'The file needs the columns Kota_Tujuan and Wilayah': 'errors.server.mdKotaColumns',
  'The file could not be read as Excel': 'errors.server.mdUnreadable',
  'Unknown master data entity': 'errors.server.mdEntityUnknown',
  'Record not found': 'errors.server.mdNotFound',
  'A record with the same key already exists': 'errors.server.mdDuplicate',
  'A reference table is missing. Run database migrations 010–014': 'errors.server.mdTableMissing',
  'Choose a wilayah': 'errors.server.wilayahChoose',
  'The item is already in that folder': 'errors.server.sameLocation',
  'Only Super Admin can move folders to the root': 'errors.server.rootAdminOnly',
  'A folder with that name already exists in the target folder': 'errors.server.folderNameExistsTarget',
  'Select at least one file or folder': 'errors.server.nothingSelected',
  'Only .xlsx, .xls or .csv files are supported': 'errors.server.bulkOnlyExcel',
  'No folder names were found in the file': 'errors.server.bulkNoNames',
  'This folder has no files to download': 'errors.server.folderEmptyZip',
  'Too many or too large files for one zip. Download sub-folders separately': 'errors.server.zipTooLarge',
  'The template has resi issues (double or invalid characters). Review them and confirm to continue': 'errors.server.resiIssuesConfirm',
  'The selected wilayah does not exist in Master Data': 'errors.server.wilayahNotInMaster',
  'The selected wilayah does not exist': 'errors.server.wilayahIdUnknown',
  'The selected kota does not belong to the selected wilayah': 'errors.server.kotaMismatch',
  'Choose a kota for the selected wilayah': 'errors.server.kotaChoose',
  'No cust IDs are set for this wilayah. Add them in Master Data → Cust ID': 'errors.server.wilayahNoCustId',
  'The wilayah master is not installed. Run database/migrations/014_master_wilayah.sql': 'errors.server.wilayahMasterMissing',
  'Wilayah name must be at least 3 characters': 'errors.server.wilayahNameInvalid',
  'Kota must be at least 2 characters': 'errors.server.wkKotaInvalid',
  'Aliases are too long (max 255 characters)': 'errors.server.aliasesTooLong',
  'Excel import is not available for this data': 'errors.server.importUnsupported',
  'This wilayah still has cust IDs or kota. Delete those first': 'errors.server.wilayahInUse',
  'Master data request failed': 'errors.server.mdFailed',
  'An Excel file is required': 'errors.server.mdFileRequired',
  'Only .xlsx or .xls files are supported': 'errors.server.mdFileType',
  'The file is empty or larger than 10 MB': 'errors.server.mdFileSize',
  'Invalid entity type': 'errors.server.mdAuditFilter',
  'Invalid action': 'errors.server.mdAuditFilter',
  'Dates must be YYYY-MM-DD': 'errors.server.mdAuditFilter',
  'Hub not found': 'errors.server.loaderHubNotFound',
  'Hub settings are not installed. Run database/migrations/012_loader_hub_kota.sql': 'errors.server.loaderHubSettingsMissing',
  // Auth store (src/stores/auth.ts) — kept in English in state, shown localized
  'Login failed': 'auth.loginFailed',
  'Could not verify your session. Check your connection and try again': 'auth.sessionCheckFailed',
  // Rechecker proxy (server/routes/recheck.js) and worker (src/lib/queue.ts)
  'Authorization failed — token is invalid or expired': 'errors.rechecker.authFailed',
  'Authorization failed — token invalid or expired': 'errors.rechecker.authFailed',
  'Forbidden — insufficient permission': 'errors.rechecker.forbidden',
  'Rate limited by SiCepat': 'errors.rechecker.rateLimited',
  'SiCepat rejected the request (bad request)': 'errors.rechecker.badRequest',
  'AWB not found': 'errors.rechecker.awbNotFound',
  'Network error — could not reach SiCepat': 'errors.rechecker.networkError',
  'Network error — could not reach the proxy/SiCepat': 'errors.rechecker.networkError',
  'Empty AWB': 'errors.rechecker.emptyAwb',
  'Duplicate AWB — already processed this session': 'errors.rechecker.duplicateAwb',
  'Stopped by user': 'errors.rechecker.stoppedByUser',
  'Empty or invalid phone number in API response': 'errors.rechecker.invalidPhone',
  'Missing credentials. Configure Bearer Token, X-Permission-Token and User ID in Settings before processing': 'errors.rechecker.missingCredentials',
  // Excel parser (src/lib/excel.ts)
  'The Excel file contains no worksheets': 'errors.rechecker.noWorksheets',
  'The Excel file is empty': 'errors.rechecker.emptyFile',
  'Could not find the "Resi" column. The file does not match the expected SiCepat format': 'errors.rechecker.noResiColumn',
  'Missing required columns. Expected at least "Resi" and "No HP Penerima" in the header row': 'errors.rechecker.missingColumns',
  'No AWB records found below the header row': 'errors.rechecker.noRecords',
  // Storage store / upload (src/stores/storage.ts, src/lib/storageApi.ts)
  'Could not load folders': 'storage.loadFoldersFailed',
  'Could not load files': 'storage.loadFilesFailed',
  'Upload failed': 'storage.uploadFailedGeneric',
  'Network error during upload. Check R2 CORS rules for your origin (PUT allowed)': 'errors.storage.uploadNetwork',
}

type Pattern = { re: RegExp; key: MessageKey; params: (m: RegExpMatchArray) => MessageParams }

const PATTERNS: Pattern[] = [
  { re: /^Cannot delete: (\d+) user\(s\) are still assigned to this role\. Reassign them first$/, key: 'errors.server.roleStillAssigned', params: (m) => ({ count: m[1] }) },
  { re: /^File exceeds the (\d+) MB limit$/, key: 'errors.server.fileTooLarge', params: (m) => ({ mb: m[1] }) },
  { re: /^File type \.(.*?) is not allowed\. Allowed: (.*)$/, key: 'errors.server.fileTypeNotAllowed', params: (m) => ({ ext: m[1], allowed: m[2] }) },
  { re: /^MIME type (.+) is not allowed$/, key: 'errors.server.mimeNotAllowed', params: (m) => ({ mime: m[1] }) },
  { re: /^Renaming to \.(.+) is not allowed$/, key: 'errors.server.renameExtNotAllowed', params: (m) => ({ ext: m[1] }) },
  { re: /^Invitation sent to (.+)$/, key: 'errors.server.invitationSentTo', params: (m) => ({ email: m[1] }) },
  { re: /^Password reset email sent to (.+)$/, key: 'errors.server.resetEmailSentTo', params: (m) => ({ email: m[1] }) },
  { re: /^Test email sent to (.+)$/, key: 'errors.server.testEmailSentTo', params: (m) => ({ email: m[1] }) },
  { re: /^Folder paths may be at most (\d+) levels deep$/, key: 'errors.server.folderPathTooDeep', params: (m) => ({ max: m[1] }) },
  { re: /^At most (\d+) folders can be added at once$/, key: 'errors.server.tooManyFoldersAtOnce', params: (m) => ({ max: m[1] }) },
  { re: /^Unknown role: (.+)$/, key: 'errors.server.unknownRole', params: (m) => ({ role: m[1] }) },
  { re: /^Unknown role id .+$/, key: 'errors.server.invalidRequest', params: () => ({}) },
  { re: /^(Unknown|Duplicate) permission key: .+$/, key: 'errors.server.invalidRequest', params: () => ({}) },
  { re: /^Status must be one of: .+$/, key: 'errors.server.invalidRequest', params: () => ({}) },
  { re: /^Invalid (userId|page|pageSize|action|module|result|from|to|id)$/, key: 'errors.server.invalidRequest', params: () => ({}) },
  { re: /^Unknown module$/, key: 'errors.server.invalidRequest', params: () => ({}) },
  { re: /^Account created, but the invitation email could not be sent \((.+)\)\. You can resend it later$/, key: 'errors.server.accountCreatedInviteFailed', params: (m) => ({ code: m[1] }) },
  { re: /^SiCepat server error \(HTTP (\d+)\)$/, key: 'errors.rechecker.upstreamError', params: (m) => ({ status: m[1] }) },
  { re: /^Request failed \(HTTP (\d+)\)$/, key: 'errors.rechecker.requestFailedStatus', params: (m) => ({ status: m[1] }) },
  { re: /^Worksheet "(.+)" not found$/, key: 'errors.rechecker.worksheetNotFound', params: (m) => ({ name: m[1] }) },
  { re: /^Storage rejected the upload \(HTTP (\d+)\)$/, key: 'errors.storage.uploadRejected', params: (m) => ({ status: m[1] }) },
  // Kodepos loader
  { re: /^No hub rows found in "(.+)"$/, key: 'errors.server.loaderDatahubEmpty', params: (m) => ({ name: m[1] }) },
  { re: /^Too many AWBs for one job \(max (\d+)\)\. Split the template$/, key: 'errors.server.loaderTooManyAwb', params: (m) => ({ max: m[1] }) },
  { re: /^The 3PL template is missing required columns: (.+)$/, key: 'errors.server.loaderMissingColumns', params: (m) => ({ columns: m[1] }) },
  { re: /^Too many folder names \(max (\d+) per file\)$/, key: 'errors.server.bulkTooMany', params: (m) => ({ max: m[1] }) },
  { re: /^The file "(.+)" could not be read as Excel$/, key: 'errors.server.loaderUnreadable', params: (m) => ({ name: m[1] }) },
  { re: /^No sheet in "(.+)" has the required columns: (.+)$/, key: 'errors.server.loaderHeadersNotFound', params: (m) => ({ name: m[1], columns: m[2] }) },
  { re: /^The (template|rechecked|master) file is required$/, key: 'errors.server.loaderFileRequired', params: (m) => ({ label: fileLabel(m[1]) }) },
  { re: /^The (template|rechecked|master) file must be an \.xlsx or \.xls file$/, key: 'errors.server.loaderFileType', params: (m) => ({ label: fileLabel(m[1]) }) },
  { re: /^The (template|rechecked|master) file is empty$/, key: 'errors.server.loaderFileEmpty', params: (m) => ({ label: fileLabel(m[1]) }) },
  { re: /^The (template|rechecked|master) file exceeds the 10 MB limit$/, key: 'errors.server.loaderFileTooLarge', params: (m) => ({ label: fileLabel(m[1]) }) },
]

function fileLabel(kind: string): string {
  return t(`loader.fileLabels.${kind}` as MessageKey)
}

const PW_RULES: Array<{ re: RegExp; key: MessageKey }> = [
  { re: /^at least (\d+) characters$/, key: 'errors.server.pwRuleLength' },
  { re: /^an uppercase letter$/, key: 'errors.server.pwRuleUpper' },
  { re: /^a lowercase letter$/, key: 'errors.server.pwRuleLower' },
  { re: /^a digit$/, key: 'errors.server.pwRuleDigit' },
  { re: /^a symbol$/, key: 'errors.server.pwRuleSymbol' },
]

/** Server password policy: "Password must contain at least 8 characters, a digit." */
function localizePasswordPolicy(body: string): string | null {
  const m = /^Password must contain (.+)$/.exec(body)
  if (!m) return null
  const parts = m[1].split(', ').map((part) => {
    for (const rule of PW_RULES) {
      const r = rule.re.exec(part)
      if (r) return t(rule.key, { count: r[1] ?? '' })
    }
    return part
  })
  return t('errors.server.passwordPolicy', { rules: parts.join(t('errors.server.listAnd')) })
}

/** Built-in role description (seeded text) → translated; edited text unchanged. */
export function localizeRoleDescription(description: string | null | undefined): string {
  if (!description) return ''
  const seeded = Object.entries(en.seedRoles).find(([, text]) => text === description)
  return seeded ? t(`seedRoles.${seeded[0]}` as MessageKey) : description
}

/** Translate a system/server message for display; unknown text passes through. */
export function localizeMessage(message: string | null | undefined): string {
  if (!message) return ''
  const body = String(message).trim().replace(/\.$/, '')
  const exact = EXACT[body]
  if (exact) return t(exact)
  for (const p of PATTERNS) {
    const m = body.match(p.re)
    if (m) return t(p.key, p.params(m))
  }
  return localizePasswordPolicy(body) ?? String(message)
}

/**
 * Message for a failed API call: the server's (localized) message when there
 * is one, a network message when there was no response, else the fallback.
 */
export function apiErrorMessage(err: unknown, fallback: MessageKey): string {
  const e = err as { response?: { data?: { message?: string } }; request?: unknown; message?: string }
  const serverMessage = e?.response?.data?.message
  if (serverMessage) return localizeMessage(serverMessage)
  if (e && e.request && !e.response) return t('errors.network')
  return t(fallback)
}
