/**
 * ============================================================================
 * INDUS Industrial Robotics — LinkedIn Auto-Publisher & Content Queue Engine
 * Google Apps Script Project: INDUS_LINKEDIN_AUTO_PUBLISHER
 * ============================================================================
 * 
 * Manages B2B Content Approval, Scheduling, and Automated Publishing to the
 * INDUS Industrial Robotics official LinkedIn Company Page.
 * 
 * Sheets Architecture:
 * 1. CONTENT_QUEUE    - Stores post payloads, media, scheduling & lifecycle status
 * 2. PUBLISHING_LOGS  - Complete audit trail of API calls, responses & errors
 * 3. SETTINGS         - Runtime flags, test mode, timezones, API versions
 * 4. DASHBOARD        - Real-time KPI metrics & execution health indicators
 * 
 * Required Script Properties (Project Settings > Script Properties):
 * - SHARED_SECRET          : Bearer secret for Vercel <-> Apps Script communication
 * - LINKEDIN_ACCESS_TOKEN  : OAuth 2.0 access token with w_organization_social
 * - LINKEDIN_REFRESH_TOKEN : OAuth 2.0 refresh token
 * - LINKEDIN_CLIENT_ID     : LinkedIn Developer Application Client ID
 * - LINKEDIN_CLIENT_SECRET : LinkedIn Developer Application Client Secret
 * - LINKEDIN_ORG_URN       : urn:li:organization:<ID> (default: urn:li:organization:106400000)
 */

var CONFIG = {
  TIMEZONE: 'Asia/Kolkata',
  DEFAULT_ORG_URN: 'urn:li:organization:106400000',
  LINKEDIN_API_VERSION: '202404',
  LINKEDIN_RESTLI_VERSION: '2.0.0',
  POSTS_API_URL: 'https://api.linkedin.com/rest/posts',
  IMAGES_API_URL: 'https://api.linkedin.com/rest/images?action=initializeUpload',
  TOKEN_URL: 'https://www.linkedin.com/oauth/v2/accessToken',
  SHEETS: {
    QUEUE: 'CONTENT_QUEUE',
    LOGS: 'PUBLISHING_LOGS',
    SETTINGS: 'SETTINGS',
    DASHBOARD: 'DASHBOARD'
  }
};

/**
 * HTTP POST Entrypoint — Receives requests from Vercel Serverless & Content Studio
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (lockErr) {
    return jsonResponse({ success: false, error: 'Server busy. Could not obtain script lock.' }, 429);
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ success: false, error: 'Missing request payload' }, 400);
    }

    var payload = JSON.parse(e.postData.contents);

    // Authentication check
    if (!authenticateRequest(e, payload)) {
      return jsonResponse({ success: false, error: 'Unauthorized: Invalid or missing authorization secret' }, 401);
    }

    var action = payload.action || 'save_post';
    var result;

    switch (action) {
      case 'save_post':
        result = handleSavePost(payload.post);
        break;

      case 'approve_post':
        result = handleApprovePost(payload.postId);
        break;

      case 'schedule_post':
        result = handleSchedulePost(payload.postId, payload.scheduledDate, payload.scheduledTime);
        break;

      case 'publish_now':
        result = handlePublishNow(payload.postId);
        break;

      case 'sync_status':
      case 'get_queue':
        result = handleGetQueue();
        break;

      case 'get_dashboard':
        result = handleGetDashboard();
        break;

      case 'setup_sheets':
        result = setupSpreadsheetSchema();
        break;

      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    return jsonResponse(result);

  } catch (err) {
    logAttempt('SYSTEM', 'doPost', 'FAILED', 500, err.toString(), 0);
    return jsonResponse({ success: false, error: err.toString() }, 500);
  } finally {
    lock.releaseLock();
  }
}

/**
 * HTTP GET Entrypoint — Health checks & queue inspection
 */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : 'health';

  if (action === 'health') {
    return jsonResponse({
      status: 'healthy',
      service: 'INDUS_LINKEDIN_AUTO_PUBLISHER',
      version: '2.0.0',
      timezone: CONFIG.TIMEZONE,
      serverTime: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
    });
  }

  if (action === 'get_queue') {
    return jsonResponse(handleGetQueue());
  }

  if (action === 'get_dashboard') {
    return jsonResponse(handleGetDashboard());
  }

  return jsonResponse({ status: 'ok', message: 'INDUS LinkedIn Auto-Publisher Gateway is operational.' });
}

/**
 * Request Authentication Validator
 */
function authenticateRequest(e, payload) {
  var props = PropertiesService.getScriptProperties();
  var expectedSecret = props.getProperty('SHARED_SECRET') || getSettingValue('SHARED_SECRET') || 'indus-publisher-secret-2026';

  // Check header or payload secret
  var providedSecret = null;
  if (payload && payload.secret) {
    providedSecret = payload.secret;
  } else if (e && e.parameter && e.parameter.secret) {
    providedSecret = e.parameter.secret;
  }

  return (providedSecret === expectedSecret);
}

/**
 * Helper to return uniform JSON output
 */
function jsonResponse(obj, statusCode) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Get Setting Value from SETTINGS sheet or Script Properties
 */
function getSettingValue(key, defaultValue) {
  var props = PropertiesService.getScriptProperties();
  var val = props.getProperty(key);
  if (val !== null && val !== undefined) return val;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.SETTINGS);
  if (sheet) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        return data[i][1];
      }
    }
  }

  return defaultValue;
}

// ============================================================================
// POST VALIDATION & LIFECYCLE HANDLERS
// ============================================================================

/**
 * Validates post fields according to industrial B2B standards
 */
function validatePostPayload(post) {
  if (!post || typeof post !== 'object') {
    return { valid: false, error: 'Invalid post object' };
  }
  if (!post.id || !post.id.trim()) {
    return { valid: false, error: 'Post ID is required' };
  }
  if (!post.title || !post.title.trim()) {
    return { valid: false, error: 'Post title is required' };
  }
  if (!post.caption || !post.caption.trim()) {
    return { valid: false, error: 'Post caption is required' };
  }
  if (post.caption.length < 50) {
    return { valid: false, error: 'Post caption is too short for a credible B2B technical post' };
  }
  if (post.imageUrl && !post.imageUrl.startsWith('http://') && !post.imageUrl.startsWith('https://')) {
    return { valid: false, error: 'Image URL must be an absolute HTTP/HTTPS address' };
  }
  return { valid: true };
}

/**
 * Action: save_post
 * Inserts or updates a post in CONTENT_QUEUE
 */
function handleSavePost(post) {
  var v = validatePostPayload(post);
  if (!v.valid) {
    return { success: false, error: v.error };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureSheet(ss, CONFIG.SHEETS.QUEUE, getQueueHeaders());

  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;
  var pid = post.id.trim();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === pid) {
      rowIndex = i + 1; // 1-based index
      break;
    }
  }

  var nowStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  var hashtagsStr = Array.isArray(post.hashtags) ? post.hashtags.join(' ') : (post.hashtags || '');
  var approvalStatus = post.approvalStatus || 'PENDING';
  var publishingStatus = post.publishingStatus || (approvalStatus === 'APPROVED' ? 'QUEUED' : 'DRAFT');

  var rowValues = [
    pid,                                    // 1. Post ID
    post.category || 'General Robotics',    // 2. Category
    post.title.trim(),                      // 3. Title
    post.caption.trim(),                    // 4. Caption
    hashtagsStr,                            // 5. Hashtags
    post.imageUrl || '',                    // 6. Image URL
    post.previewUrl || post.imageUrl || '', // 7. Image Preview URL
    post.mediaType || 'IMAGE',              // 8. Media Type
    nowStr,                                 // 9. Created At
    post.scheduledDate || '',               // 10. Scheduled Date (YYYY-MM-DD)
    post.scheduledTime || '',               // 11. Scheduled Time (HH:MM:SS)
    approvalStatus,                         // 12. Approval Status
    publishingStatus,                       // 13. Publishing Status
    '',                                     // 14. LinkedIn Post URN
    '',                                     // 15. LinkedIn Post URL
    '',                                     // 16. Published At
    '',                                     // 17. Error Message
    nowStr                                  // 18. Updated At
  ];

  if (rowIndex > -1) {
    // Preserve existing published URNs and creation timestamps
    var existingRow = data[rowIndex - 1];
    rowValues[8] = existingRow[8] || nowStr; // Keep original Created At
    if (existingRow[13]) rowValues[13] = existingRow[13]; // Keep URN
    if (existingRow[14]) rowValues[14] = existingRow[14]; // Keep URL
    if (existingRow[15]) rowValues[15] = existingRow[15]; // Keep Published At

    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
    logAttempt(pid, 'UPDATE_POST', 'SUCCESS', 200, 'Post updated successfully in CONTENT_QUEUE', 0);
  } else {
    sheet.appendRow(rowValues);
    logAttempt(pid, 'INSERT_POST', 'SUCCESS', 201, 'New post appended to CONTENT_QUEUE', 0);
  }

  refreshDashboardSheet();

  return {
    success: true,
    message: 'Post ' + pid + ' saved to CONTENT_QUEUE successfully',
    postId: pid,
    approvalStatus: approvalStatus,
    publishingStatus: publishingStatus
  };
}

/**
 * Action: approve_post
 * Sets Approval Status to APPROVED and Publishing Status to QUEUED
 */
function handleApprovePost(postId) {
  if (!postId) return { success: false, error: 'Post ID required' };
  postId = postId.trim();

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
  if (!sheet) return { success: false, error: 'CONTENT_QUEUE sheet not found' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === postId) {
      var rowNum = i + 1;
      var currentPubStatus = data[i][12];

      // Do not re-queue if already published
      if (currentPubStatus === 'PUBLISHED') {
        return { success: false, error: 'Post ' + postId + ' is already published' };
      }

      sheet.getRange(rowNum, 12).setValue('APPROVED');
      sheet.getRange(rowNum, 13).setValue('QUEUED');
      sheet.getRange(rowNum, 18).setValue(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));

      logAttempt(postId, 'APPROVE_POST', 'SUCCESS', 200, 'Post approved and queued for publishing', 0);
      refreshDashboardSheet();

      return { success: true, message: 'Post ' + postId + ' approved and queued', postId: postId };
    }
  }

  return { success: false, error: 'Post ID ' + postId + ' not found in CONTENT_QUEUE' };
}

/**
 * Action: schedule_post
 * Updates Scheduled Date and Time
 */
function handleSchedulePost(postId, dateStr, timeStr) {
  if (!postId) return { success: false, error: 'Post ID required' };
  if (!dateStr || !timeStr) return { success: false, error: 'Both scheduledDate and scheduledTime are required' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
  if (!sheet) return { success: false, error: 'CONTENT_QUEUE sheet not found' };

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === postId) {
      var rowNum = i + 1;
      sheet.getRange(rowNum, 10).setValue(dateStr);
      sheet.getRange(rowNum, 11).setValue(timeStr);
      sheet.getRange(rowNum, 18).setValue(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));

      logAttempt(postId, 'SCHEDULE_POST', 'SUCCESS', 200, 'Scheduled for ' + dateStr + ' ' + timeStr, 0);
      refreshDashboardSheet();

      return {
        success: true,
        message: 'Post ' + postId + ' scheduled for ' + dateStr + ' ' + timeStr + ' (' + CONFIG.TIMEZONE + ')',
        postId: postId,
        scheduledDate: dateStr,
        scheduledTime: timeStr
      };
    }
  }

  return { success: false, error: 'Post ID ' + postId + ' not found in CONTENT_QUEUE' };
}

/**
 * Action: publish_now
 * Immediately approves and publishes post
 */
function handlePublishNow(postId) {
  if (!postId) return { success: false, error: 'Post ID required' };
  postId = postId.trim();

  // Approve first
  var appRes = handleApprovePost(postId);
  if (!appRes.success && appRes.error.indexOf('already published') > -1) {
    return appRes;
  }

  // Publish single post immediately
  return publishSinglePost(postId, true);
}

/**
 * Action: get_queue
 */
function handleGetQueue() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
  if (!sheet) return { success: true, count: 0, posts: [] };

  var data = sheet.getDataRange().getValues();
  var posts = [];

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (!r[0]) continue;
    posts.push({
      id: r[0],
      category: r[1],
      title: r[2],
      caption: r[3],
      hashtags: r[4],
      imageUrl: r[5],
      previewUrl: r[6],
      mediaType: r[7],
      createdAt: r[8],
      scheduledDate: r[9],
      scheduledTime: r[10],
      approvalStatus: r[11],
      publishingStatus: r[12],
      linkedinUrn: r[13],
      linkedinUrl: r[14],
      publishedAt: r[15],
      errorMessage: r[16]
    });
  }

  return {
    success: true,
    count: posts.length,
    posts: posts,
    serverTime: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
  };
}

/**
 * Action: get_dashboard
 */
function handleGetDashboard() {
  refreshDashboardSheet();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.DASHBOARD);
  if (!sheet) return { success: false, error: 'DASHBOARD sheet not initialized' };

  var data = sheet.getDataRange().getValues();
  var metrics = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      metrics[data[i][0]] = data[i][1];
    }
  }

  return {
    success: true,
    metrics: metrics,
    serverTime: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')
  };
}

// ============================================================================
// SCHEDULING ENGINE & AUTOMATION TRIGGER
// ============================================================================

/**
 * Installable Time-Driven Trigger
 * Runs every minute to evaluate scheduled queue items
 */
function processScheduledPosts() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    Logger.log('Process scheduled posts skipped: Concurrent execution lock held.');
    return;
  }

  try {
    var publishingEnabled = getSettingValue('PUBLISHING_ENABLED', 'TRUE').toString().toUpperCase() === 'TRUE';
    if (!publishingEnabled) {
      Logger.log('LinkedIn Auto-Publishing is currently PAUSED via SETTINGS.');
      return;
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
    if (!sheet) return;

    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var nowDateStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    var nowTimeStr = Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm');

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var pid = row[0];
      var approvalStatus = (row[11] || '').toString().toUpperCase();
      var pubStatus = (row[12] || '').toString().toUpperCase();
      var schedDate = (row[9] || '').toString().trim();
      var schedTime = (row[10] || '').toString().trim();

      // Rule: Must be APPROVED and QUEUED
      if (approvalStatus === 'APPROVED' && pubStatus === 'QUEUED') {
        var isDue = false;

        if (!schedDate || !schedTime) {
          // If no specific schedule was set, but approved, treat as immediate
          isDue = true;
        } else {
          // Compare dates
          if (schedDate < nowDateStr) {
            isDue = true;
          } else if (schedDate === nowDateStr) {
            // Compare times (HH:mm)
            var cleanSchedTime = schedTime.substring(0, 5);
            if (cleanSchedTime <= nowTimeStr) {
              isDue = true;
            }
          }
        }

        if (isDue) {
          // Set to PROCESSING immediately to prevent concurrent triggers from re-processing
          sheet.getRange(i + 1, 13).setValue('PROCESSING');
          sheet.getRange(i + 1, 18).setValue(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));
          SpreadsheetApp.flush();

          // Execute publishing
          publishSinglePost(pid, false);
        }
      }
    }

    refreshDashboardSheet();

  } catch (err) {
    logAttempt('CRON', 'processScheduledPosts', 'FAILED', 500, err.toString(), 0);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Publishes a single post by ID
 */
function publishSinglePost(postId, isImmediate) {
  var startTime = Date.now();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
  if (!sheet) return { success: false, error: 'Queue sheet missing' };

  var data = sheet.getDataRange().getValues();
  var targetRow = -1;
  var postObj = null;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString().trim() === postId) {
      targetRow = i + 1;
      postObj = {
        id: data[i][0],
        category: data[i][1],
        title: data[i][2],
        caption: data[i][3],
        hashtags: data[i][4],
        imageUrl: data[i][5],
        mediaType: data[i][7] || 'IMAGE'
      };
      break;
    }
  }

  if (!postObj) {
    return { success: false, error: 'Post ' + postId + ' not found in queue' };
  }

  var testMode = getSettingValue('TEST_MODE', 'FALSE').toString().toUpperCase() === 'TRUE';
  var orgUrn = getSettingValue('ORGANIZATION_URN', CONFIG.DEFAULT_ORG_URN);
  var accessToken = getLinkedInAccessToken();

  if (!testMode && !accessToken) {
    var noTokenErr = 'LinkedIn Access Token missing or invalid. Configure Script Properties or refresh OAuth token.';
    sheet.getRange(targetRow, 13).setValue('FAILED');
    sheet.getRange(targetRow, 17).setValue(noTokenErr);
    logAttempt(postId, 'PUBLISH', 'FAILED', 401, noTokenErr, Date.now() - startTime);
    return { success: false, error: noTokenErr };
  }

  try {
    var result;

    if (testMode) {
      // Simulated Test Publishing
      Utilities.sleep(600); // Simulate network latency
      var simId = 'urn:li:share:simulated_test_' + Date.now();
      result = {
        success: true,
        postUrn: simId,
        postUrl: 'https://www.linkedin.com/feed/update/' + simId,
        isSimulated: true
      };
    } else {
      // Live Official LinkedIn API Publishing
      result = dispatchLinkedInPost(postObj, orgUrn, accessToken);
    }

    var elapsed = Date.now() - startTime;

    if (result.success) {
      var publishedAt = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
      sheet.getRange(targetRow, 13).setValue('PUBLISHED');
      sheet.getRange(targetRow, 14).setValue(result.postUrn);
      sheet.getRange(targetRow, 15).setValue(result.postUrl);
      sheet.getRange(targetRow, 16).setValue(publishedAt);
      sheet.getRange(targetRow, 17).setValue('');
      sheet.getRange(targetRow, 18).setValue(publishedAt);

      logAttempt(postId, 'PUBLISH', 'SUCCESS', 201, 'Published to LinkedIn: ' + result.postUrn, elapsed);
      refreshDashboardSheet();

      return {
        success: true,
        message: 'Successfully published post ' + postId + ' to LinkedIn',
        postId: postId,
        postUrn: result.postUrn,
        postUrl: result.postUrl,
        publishedAt: publishedAt
      };
    } else {
      sheet.getRange(targetRow, 13).setValue('FAILED');
      sheet.getRange(targetRow, 17).setValue(result.error);
      sheet.getRange(targetRow, 18).setValue(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss'));

      logAttempt(postId, 'PUBLISH', 'FAILED', result.statusCode || 500, result.error, elapsed);
      refreshDashboardSheet();

      return {
        success: false,
        error: result.error,
        statusCode: result.statusCode
      };
    }

  } catch (ex) {
    var execElapsed = Date.now() - startTime;
    sheet.getRange(targetRow, 13).setValue('FAILED');
    sheet.getRange(targetRow, 17).setValue(ex.toString());
    logAttempt(postId, 'PUBLISH_EXCEPTION', 'FAILED', 500, ex.toString(), execElapsed);
    return { success: false, error: ex.toString() };
  }
}

// ============================================================================
// LINKEDIN OFFICIAL REST API ENGINE
// ============================================================================

/**
 * Dispatches post to official LinkedIn Posts API (POST https://api.linkedin.com/rest/posts)
 */
function dispatchLinkedInPost(post, orgUrn, accessToken) {
  var headers = {
    'Authorization': 'Bearer ' + accessToken,
    'LinkedIn-Version': CONFIG.LINKEDIN_API_VERSION,
    'X-Restli-Protocol-Version': CONFIG.LINKEDIN_RESTLI_VERSION,
    'Content-Type': 'application/json'
  };

  var imageUrn = null;

  // Handle Image Upload if image URL is supplied
  if (post.imageUrl && post.mediaType !== 'TEXT') {
    var imgRes = uploadLinkedInImage(post.imageUrl, orgUrn, accessToken);
    if (!imgRes.success) {
      return { success: false, error: 'Image upload failed: ' + imgRes.error, statusCode: imgRes.statusCode };
    }
    imageUrn = imgRes.imageUrn;
  }

  // Construct Commentary text (Caption + Hashtags)
  var commentary = post.caption.trim();
  if (post.hashtags && post.hashtags.trim()) {
    commentary += '\n\n' + post.hashtags.trim();
  }

  var postPayload = {
    author: orgUrn,
    commentary: commentary,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: []
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false
  };

  // Attach Media if image was uploaded
  if (imageUrn) {
    postPayload.content = {
      media: {
        id: imageUrn,
        title: post.title.substring(0, 100)
      }
    };
  }

  var options = {
    method: 'post',
    headers: headers,
    payload: JSON.stringify(postPayload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(CONFIG.POSTS_API_URL, options);
  var statusCode = response.getResponseCode();
  var respText = response.getContentText();

  if (statusCode === 201) {
    // 201 Created returns post URN in x-linkedin-id or x-restli-id header
    var allHeaders = response.getAllHeaders();
    var postUrn = allHeaders['x-restli-id'] || allHeaders['x-linkedin-id'] || '';

    if (!postUrn) {
      try {
        var parsed = JSON.parse(respText);
        postUrn = parsed.id || '';
      } catch (e) {}
    }

    var postUrl = 'https://www.linkedin.com/feed/update/' + (postUrn || '');

    return {
      success: true,
      statusCode: statusCode,
      postUrn: postUrn,
      postUrl: postUrl
    };
  } else {
    var errMsg = 'LinkedIn Posts API returned HTTP ' + statusCode + ': ' + respText;
    return {
      success: false,
      statusCode: statusCode,
      error: errMsg
    };
  }
}

/**
 * Initializes and uploads image binary to LinkedIn Images API
 */
function uploadLinkedInImage(imageUrl, orgUrn, accessToken) {
  try {
    // 1. Initialize Upload
    var initHeaders = {
      'Authorization': 'Bearer ' + accessToken,
      'LinkedIn-Version': CONFIG.LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': CONFIG.LINKEDIN_RESTLI_VERSION,
      'Content-Type': 'application/json'
    };

    var initBody = {
      initializeUploadRequest: {
        owner: orgUrn
      }
    };

    var initOptions = {
      method: 'post',
      headers: initHeaders,
      payload: JSON.stringify(initBody),
      muteHttpExceptions: true
    };

    var initResp = UrlFetchApp.fetch(CONFIG.IMAGES_API_URL, initOptions);
    var initCode = initResp.getResponseCode();
    if (initCode !== 200 && initCode !== 201) {
      return { success: false, statusCode: initCode, error: 'initializeUpload returned HTTP ' + initCode + ': ' + initResp.getContentText() };
    }

    var initData = JSON.parse(initResp.getContentText());
    var uploadUrl = initData.value.uploadUrl;
    var imageUrn = initData.value.image;

    // 2. Fetch image binary from public URL
    var imageFetch = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
    if (imageFetch.getResponseCode() !== 200) {
      return { success: false, statusCode: imageFetch.getResponseCode(), error: 'Could not fetch image asset from URL: ' + imageUrl };
    }

    var imageBlob = imageFetch.getBlob();

    // 3. PUT binary to uploadUrl
    var uploadOptions = {
      method: 'put',
      payload: imageBlob.getBytes(),
      headers: {
        'Content-Type': imageBlob.getContentType() || 'image/png'
      },
      muteHttpExceptions: true
    };

    var putResp = UrlFetchApp.fetch(uploadUrl, uploadOptions);
    var putCode = putResp.getResponseCode();
    if (putCode !== 200 && putCode !== 201) {
      return { success: false, statusCode: putCode, error: 'Image binary PUT returned HTTP ' + putCode };
    }

    return {
      success: true,
      imageUrn: imageUrn
    };

  } catch (err) {
    return { success: false, statusCode: 500, error: err.toString() };
  }
}

/**
 * Retrieves valid Access Token, automatically refreshing if needed
 */
function getLinkedInAccessToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('LINKEDIN_ACCESS_TOKEN');
  var expiry = props.getProperty('LINKEDIN_TOKEN_EXPIRY');

  // If token is fresh (with 10-minute buffer), return it
  if (token && expiry && Date.now() < (Number(expiry) - 600000)) {
    return token;
  }

  // Attempt refresh
  var refreshToken = props.getProperty('LINKEDIN_REFRESH_TOKEN');
  var clientId = props.getProperty('LINKEDIN_CLIENT_ID');
  var clientSecret = props.getProperty('LINKEDIN_CLIENT_SECRET');

  if (refreshToken && clientId && clientSecret) {
    try {
      var refreshPayload = {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      };

      var resp = UrlFetchApp.fetch(CONFIG.TOKEN_URL, {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: refreshPayload,
        muteHttpExceptions: true
      });

      if (resp.getResponseCode() === 200) {
        var tokenData = JSON.parse(resp.getContentText());
        var newToken = tokenData.access_token;
        var expiresIn = tokenData.expires_in || 5184000; // 60 days default
        var newExpiry = Date.now() + (expiresIn * 1000);

        props.setProperty('LINKEDIN_ACCESS_TOKEN', newToken);
        props.setProperty('LINKEDIN_TOKEN_EXPIRY', newExpiry.toString());
        if (tokenData.refresh_token) {
          props.setProperty('LINKEDIN_REFRESH_TOKEN', tokenData.refresh_token);
        }

        Logger.log('Successfully refreshed LinkedIn OAuth access token.');
        return newToken;
      } else {
        Logger.log('Token refresh failed HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText());
      }
    } catch (e) {
      Logger.log('Exception during token refresh: ' + e.toString());
    }
  }

  return token; // fallback to existing token
}

// ============================================================================
// AUDIT LOGGING & SPREADSHEET SCHEMA MANAGEMENT
// ============================================================================

/**
 * Appends record to PUBLISHING_LOGS
 */
function logAttempt(postId, action, status, httpCode, details, execTimeMs) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensureSheet(ss, CONFIG.SHEETS.LOGS, getLogsHeaders());

    var logId = 'log_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    var ts = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    sheet.appendRow([
      logId,
      ts,
      postId || 'SYSTEM',
      action,
      status,
      httpCode || '',
      details ? details.toString().substring(0, 500) : '',
      execTimeMs || 0
    ]);
  } catch (e) {
    Logger.log('Failed to write log: ' + e.toString());
  }
}

/**
 * Refreshes and recalculates DASHBOARD metrics
 */
function refreshDashboardSheet() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var qSheet = ss.getSheetByName(CONFIG.SHEETS.QUEUE);
    var dSheet = ensureSheet(ss, CONFIG.SHEETS.DASHBOARD, ['Metric', 'Value', 'Updated At']);

    var total = 0;
    var pending = 0;
    var queued = 0;
    var published = 0;
    var failed = 0;
    var nextSched = 'None Scheduled';
    var nextSchedTime = Infinity;

    if (qSheet) {
      var data = qSheet.getDataRange().getValues();
      total = Math.max(0, data.length - 1);

      for (var i = 1; i < data.length; i++) {
        var appStatus = (data[i][11] || '').toString().toUpperCase();
        var pubStatus = (data[i][12] || '').toString().toUpperCase();
        var schedDate = (data[i][9] || '').toString();
        var schedTime = (data[i][10] || '').toString();

        if (appStatus === 'PENDING') pending++;
        if (pubStatus === 'QUEUED') queued++;
        if (pubStatus === 'PUBLISHED') published++;
        if (pubStatus === 'FAILED') failed++;

        if (pubStatus === 'QUEUED' && schedDate && schedTime) {
          var combined = schedDate + ' ' + schedTime;
          if (combined < nextSchedTime) {
            nextSchedTime = combined;
            nextSched = data[i][0] + ' (' + combined + ' IST)';
          }
        }
      }
    }

    var successRate = (published + failed > 0) ? Math.round((published / (published + failed)) * 100) + '%' : '100%';
    var nowStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    var metricsData = [
      ['Metric', 'Value', 'Updated At'],
      ['Total Posts in Queue', total, nowStr],
      ['Pending Approval', pending, nowStr],
      ['Approved & Queued', queued, nowStr],
      ['Successfully Published', published, nowStr],
      ['Failed Posts', failed, nowStr],
      ['Publishing Success Rate', successRate, nowStr],
      ['Next Scheduled Post', nextSched, nowStr],
      ['Timezone', CONFIG.TIMEZONE, nowStr],
      ['Engine Status', getSettingValue('PUBLISHING_ENABLED', 'TRUE').toUpperCase() === 'TRUE' ? 'ACTIVE' : 'PAUSED', nowStr],
      ['Test Mode', getSettingValue('TEST_MODE', 'FALSE').toUpperCase() === 'TRUE' ? 'ENABLED (Dry Run)' : 'DISABLED (Live API)', nowStr]
    ];

    dSheet.getRange(1, 1, metricsData.length, 3).setValues(metricsData);

  } catch (e) {
    Logger.log('refreshDashboardSheet error: ' + e.toString());
  }
}

/**
 * Initializes Spreadsheet Schema & Tabs
 */
function setupSpreadsheetSchema() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  ensureSheet(ss, CONFIG.SHEETS.QUEUE, getQueueHeaders());
  ensureSheet(ss, CONFIG.SHEETS.LOGS, getLogsHeaders());
  ensureSheet(ss, CONFIG.SHEETS.SETTINGS, ['Setting Key', 'Setting Value', 'Description']);
  ensureSheet(ss, CONFIG.SHEETS.DASHBOARD, ['Metric', 'Value', 'Updated At']);

  // Populate Default Settings
  var setSheet = ss.getSheetByName(CONFIG.SHEETS.SETTINGS);
  if (setSheet && setSheet.getLastRow() <= 1) {
    var defaults = [
      ['PUBLISHING_ENABLED', 'TRUE', 'Master switch for automated publishing trigger (TRUE/FALSE)'],
      ['TEST_MODE', 'FALSE', 'Dry-run mode: simulates LinkedIn API success without live posting (TRUE/FALSE)'],
      ['TIMEZONE', 'Asia/Kolkata', 'Operating timezone for scheduled publishing'],
      ['ORGANIZATION_URN', CONFIG.DEFAULT_ORG_URN, 'LinkedIn Author Organization URN (urn:li:organization:<ID>)'],
      ['API_VERSION', CONFIG.LINKEDIN_API_VERSION, 'LinkedIn REST Posts API version header'],
      ['SHARED_SECRET', 'indus-publisher-secret-2026', 'Shared authorization secret for Vercel backend integration']
    ];
    setSheet.getRange(2, 1, defaults.length, 3).setValues(defaults);
  }

  refreshDashboardSheet();

  return { success: true, message: 'All 4 publisher sheets initialized successfully.' };
}

function ensureSheet(ss, sheetName, headers) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }
  if (sheet.getLastRow() === 0 && headers && headers.length > 0) {
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#0B192A');
    headerRange.setFontColor('#20B8F5');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getQueueHeaders() {
  return [
    'Post ID',
    'Category',
    'Title',
    'Caption',
    'Hashtags',
    'Image URL',
    'Image Preview URL',
    'Media Type',
    'Created At',
    'Scheduled Date',
    'Scheduled Time',
    'Approval Status',
    'Publishing Status',
    'LinkedIn Post URN',
    'LinkedIn Post URL',
    'Published At',
    'Error Message',
    'Updated At'
  ];
}

function getLogsHeaders() {
  return [
    'Log ID',
    'Timestamp',
    'Post ID',
    'Action',
    'Status',
    'HTTP Status Code',
    'Response / Details',
    'Execution Time (ms)'
  ];
}

/**
 * Triggers Setup Helper — Can be run manually once from Apps Script Editor
 */
function installPublishingTrigger() {
  // Clear existing triggers for processScheduledPosts
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processScheduledPosts') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create 1-minute time-driven trigger
  ScriptApp.newTrigger('processScheduledPosts')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Successfully installed 1-minute time-driven trigger for processScheduledPosts.');
}
