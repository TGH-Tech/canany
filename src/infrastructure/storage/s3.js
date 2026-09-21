// S3 adapter for #ask attachments. One client; two operations:
//  - putAttachment: stream a file's bytes into the private bucket (ingest)
//  - getAttachment: open a read stream of a stored object (serve)
// Works against AWS S3 or any S3-compatible store (the platform's MinIO bucket):
// endpoint, path-style addressing and credentials all come from src/config.
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const config = require('../../config');

const client = new S3Client({
  region: config.storage.region,
  ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
  forcePathStyle: config.storage.forcePathStyle,
  ...(config.storage.credentials ? { credentials: config.storage.credentials } : {}),
});

// Key layout: attachments/<orgId>/<askId>/<index>-<fileUniqueId>. The <index>-
// prefix (0-based position of the file within its message/album) makes the key
// collision-safe: fileUniqueId is stable per file in Telegram, so the same image
// attached twice to one ask would otherwise compute the same key and overwrite.
function keyFor({ orgId, askId, index, fileUniqueId }) {
  return `attachments/${orgId}/${askId}/${index}-${fileUniqueId}`;
}

// Upload via lib-storage's Upload, which streams a body of unknown length cleanly.
// Returns the stored object key.
async function putAttachment({ orgId, askId, index, fileUniqueId, body, contentType }) {
  const Key = keyFor({ orgId, askId, index, fileUniqueId });
  await new Upload({
    client,
    params: {
      Bucket: config.storage.bucket,
      Key,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
      CacheControl: 'private, max-age=31536000, immutable',
    },
  }).done();
  return Key;
}

// Open a stored object for streaming to a browser. The bucket is private and its
// endpoint may be reachable only from inside the deployment network, so the web
// board proxies bytes through the app (see routes.js GET /attachments/:id)
// instead of handing out presigned URLs.
async function getAttachment(key) {
  const out = await client.send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: key }));
  return { body: out.Body, contentType: out.ContentType || null, contentLength: out.ContentLength ?? null };
}

module.exports = { putAttachment, getAttachment, keyFor };
