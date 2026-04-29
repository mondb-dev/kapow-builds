import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import { createReadStream, createWriteStream, writeFileSync } from 'fs';
import { join } from 'path';
import { Readable } from 'stream';

function getAuth() {
  return new GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
}

// ── Drive ────────────────────────────────────────────────────────────

export async function gdriveUpload(
  sandboxPath: string,
  filePath: string,
  fileName?: string,
  folderId?: string,
  mimeType?: string,
): Promise<string> {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const absPath = join(sandboxPath, filePath);
  const name = fileName ?? filePath.split('/').pop() ?? 'untitled';

  const res = await drive.files.create({
    requestBody: {
      name,
      ...(folderId ? { parents: [folderId] } : {}),
      ...(mimeType ? { mimeType } : {}),
    },
    media: {
      mimeType: mimeType ?? 'application/octet-stream',
      body: createReadStream(absPath),
    },
    fields: 'id,name,webViewLink,webContentLink',
  });

  const file = res.data;

  // Make publicly readable
  await drive.permissions.create({
    fileId: file.id!,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return JSON.stringify({
    fileId: file.id,
    name: file.name,
    url: file.webViewLink ?? file.webContentLink,
  });
}

export async function gdriveRead(
  sandboxPath: string,
  fileId: string,
  outputPath: string,
): Promise<string> {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });
  const absPath = join(sandboxPath, outputPath);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' },
  );

  await new Promise<void>((resolve, reject) => {
    const dest = createWriteStream(absPath);
    (res.data as NodeJS.ReadableStream).pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  return `Downloaded Drive file ${fileId} to ${outputPath}`;
}

export async function gdriveList(folderId?: string): Promise<string> {
  const auth = getAuth();
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: folderId ? `'${folderId}' in parents and trashed=false` : 'trashed=false',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
    pageSize: 50,
    orderBy: 'modifiedTime desc',
  });

  return JSON.stringify(res.data.files ?? []);
}

// ── Docs ─────────────────────────────────────────────────────────────

export async function gdocsCreate(
  title: string,
  content: string,
): Promise<string> {
  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  // Create empty doc
  const doc = await docs.documents.create({ requestBody: { title } });
  const docId = doc.data.documentId!;

  // Insert content as plain text
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: 1 },
          text: content,
        },
      }],
    },
  });

  // Make publicly readable
  await drive.permissions.create({
    fileId: docId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return JSON.stringify({
    docId,
    title,
    url: `https://docs.google.com/document/d/${docId}/edit`,
  });
}

export async function gdocsRead(documentId: string): Promise<string> {
  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({ documentId });
  const body = res.data.body?.content ?? [];

  const text = body
    .flatMap((el) => el.paragraph?.elements ?? [])
    .map((el) => el.textRun?.content ?? '')
    .join('');

  return text.slice(0, 20000);
}

export async function gdocsAppend(documentId: string, content: string): Promise<string> {
  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });

  const doc = await docs.documents.get({ documentId });
  const endIndex = doc.data.body?.content?.slice(-1)[0]?.endIndex ?? 1;

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: endIndex - 1 },
          text: '\n' + content,
        },
      }],
    },
  });

  return `Appended ${content.length} chars to doc ${documentId}`;
}

// ── Sheets ───────────────────────────────────────────────────────────

export async function gsheetsRead(
  spreadsheetId: string,
  range: string = 'Sheet1',
): Promise<string> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return JSON.stringify(res.data.values ?? []);
}

export async function gsheetsWrite(
  spreadsheetId: string,
  range: string,
  values: unknown[][],
): Promise<string> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  return `Updated ${res.data.updatedCells ?? 0} cells in ${spreadsheetId}`;
}

export async function gsheetsCreate(title: string, headers?: string[]): Promise<string> {
  const auth = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const drive = google.drive({ version: 'v3', auth });

  const res = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      ...(headers ? {
        sheets: [{
          data: [{
            rowData: [{
              values: headers.map((h) => ({ userEnteredValue: { stringValue: h } })),
            }],
          }],
        }],
      } : {}),
    },
  });

  const spreadsheetId = res.data.spreadsheetId!;

  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return JSON.stringify({
    spreadsheetId,
    title,
    url: res.data.spreadsheetUrl,
  });
}

// ── Gmail ────────────────────────────────────────────────────────────

export async function gmailSend(
  to: string,
  subject: string,
  body: string,
  isHtml: boolean = false,
): Promise<string> {
  const auth = getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const contentType = isHtml ? 'text/html' : 'text/plain';
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });

  return `Email sent to ${to} — message ID: ${res.data.id}`;
}
