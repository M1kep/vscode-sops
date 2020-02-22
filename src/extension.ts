import * as vscode from 'vscode';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as child_process from 'child_process';
import * as YAML from 'yaml';
import * as path from 'path';
import * as crypto from 'crypto';
import * as Debug from 'debug';
import { TextEncoder, TextDecoder } from 'text-encoding';
const debug = Debug('@signageos/vscode-sops');

const convertUtf8ToUint8Array = (input: string) => new TextEncoder("utf-8").encode(input);
const contertUint8ArrayToUtf8 = (input: Uint8Array) => new TextDecoder("utf-8").decode(input);

const DECRYPTED_PREFIX = '.decrypted~';
let sopsBinPath = 'sops'; // TODO configuration
let fakeDecryptedEditor = __dirname + '/../tools/decryptedEditor.sh'; // TODO non unix decryption
let spawnOptions: child_process.SpawnSyncOptions = {
	cwd: process.env.HOME,
};

type IFileFormat = 'yaml' | 'json';

async function handleFile(document: vscode.TextDocument, fileFormat: IFileFormat) {
	debug('handleFile');
	const fileContent = await getFileContent(document.uri);
	const parser = getParser(fileFormat);
	const fileData = parser(fileContent);
	debug('YAML', fileData);
	if (typeof fileData.sops?.version === 'string') {
		await ensureOpenDecryptedFile(document.uri, 'yaml');
	}
}

function getParser(fileFormat: IFileFormat) {
	switch (fileFormat) {
		case 'yaml': return YAML.parse;
		case 'json': return JSON.parse;
	}
}

async function ensureOpenDecryptedFile(encryptedUri: vscode.Uri, fileFormat: IFileFormat) {
	debug('Opening', encryptedUri.path);
	const decryptedFileName = DECRYPTED_PREFIX + path.basename(encryptedUri.path);
	const decryptedFilePath = path.join(path.dirname(encryptedUri.path), decryptedFileName);
	const decryptedUri = encryptedUri.with({ path: decryptedFilePath });

	if (!await fileExists(decryptedUri)) {
		debug('Not decrypted', decryptedUri.path);
		await decryptFileToFile(encryptedUri, decryptedUri, fileFormat);
	}

	const originalFileContent = await getDecryptedFileContent(encryptedUri, fileFormat);
	const currentFileContent = await getFileContent(decryptedUri);
	debug('Comparing files', { originalFileContent, currentFileContent });
	const encryptedContentChecksum = await getChecksum(originalFileContent);
	const decryptedContentChecksum = await getChecksum(currentFileContent);
	debug('Content checksums', { encryptedContentChecksum, decryptedContentChecksum });
	if (encryptedContentChecksum !== decryptedContentChecksum) {
		const encryptedStat = await vscode.workspace.fs.stat(encryptedUri);
		const decryptedStat = await vscode.workspace.fs.stat(decryptedUri);
		debug('Content stats', { encryptedStat, decryptedStat });
		if (encryptedStat.mtime > decryptedStat.mtime) {
			debug('Updating decrypted');
			await decryptFileToFile(encryptedUri, decryptedUri, fileFormat);
		} else if (encryptedStat.mtime < decryptedStat.mtime) {
			debug('Updating encrypted');
			await encryptFileToFile(decryptedUri, encryptedUri, fileFormat);
		}
	}
	if (!isFileOpen(decryptedUri)) {
		await openFile(decryptedUri);
	}
}

function isFileOpen(uri: vscode.Uri) {
	return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.path === uri.path);
}

async function openFile(uri: vscode.Uri) {
	return await vscode.window.showTextDocument(uri);
}

async function closeFile(uri: vscode.Uri) {
	const visibleEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.path === uri.path);
	if (!visibleEditor) {
		await vscode.workspace.fs.delete(uri);
	}
}

async function decryptFileToFile(encryptedUri: vscode.Uri, decryptedUri: vscode.Uri, fileFormat: IFileFormat) {
	const decryptedContent = await getDecryptedFileContent(encryptedUri, fileFormat);
	await vscode.workspace.fs.writeFile(decryptedUri, convertUtf8ToUint8Array(decryptedContent));
}

async function encryptFileToFile(decryptedUri: vscode.Uri, encryptedUri: vscode.Uri, fileFormat: IFileFormat) {
	const encryptedContent = await getEncryptedFileContent(decryptedUri, encryptedUri, fileFormat);
	await vscode.workspace.fs.writeFile(encryptedUri, convertUtf8ToUint8Array(encryptedContent));
}

async function getChecksum(content: string) {
	const md5sum = crypto.createHash('md5');
	md5sum.update(content);
	return md5sum.digest('hex');
}

async function getFileContent(uri: vscode.Uri) {
	const fileContent = await vscode.workspace.fs.readFile(uri);
	return contertUint8ArrayToUtf8(fileContent);
}

async function getDecryptedFileContent(uri: vscode.Uri, fileFormat: IFileFormat) {
	const encryptedContent = await getFileContent(uri);
	const tmpEncryptedFilePath = path.join(os.tmpdir(), await getChecksum(Math.random().toString()));
	try {
		await fs.writeFile(tmpEncryptedFilePath, encryptedContent, { mode: 0o600 });
		debug('Decrypting', uri.path, encryptedContent);
		const decryptProcess = child_process.spawnSync(
			sopsBinPath,
			[
				'--output-type',
				fileFormat,
				'--input-type',
				fileFormat,
				'--decrypt',
				tmpEncryptedFilePath,
			],
			spawnOptions,
		);
		if (decryptProcess.error) {
			throw decryptProcess.error;
		}
		if (decryptProcess.stderr.toString()) {
			throw new Error(decryptProcess.stderr.toString());
		}
		const decryptedContent = decryptProcess.stdout.toString();
		debug('Decrypted', uri.path, decryptedContent);
		if (!decryptedContent) {
			throw new Error(`Could not decrypt file: ${uri.path}`);
		}
		return decryptedContent;
	} finally {
		await fs.remove(tmpEncryptedFilePath);
	}
}

async function getEncryptedFileContent(uri: vscode.Uri, originalEncryptedUri: vscode.Uri, fileFormat: IFileFormat) {
	const decryptedContent = await getFileContent(uri);
	const originalEncryptedContent = await getFileContent(originalEncryptedUri);
	const tmpDecryptedFilePath = path.join(os.tmpdir(), await getChecksum(Math.random().toString()));
	const tmpEncryptedFilePath = path.join(os.tmpdir(), await getChecksum(Math.random().toString()));
	try {
		await fs.writeFile(tmpDecryptedFilePath, decryptedContent, { mode: 0o600 });
		await fs.writeFile(tmpEncryptedFilePath, originalEncryptedContent, { mode: 0o600 });
		debug('Encrypting', uri.path, decryptedContent);
		const encryptProcess = child_process.spawnSync(
			sopsBinPath,
			[
				'--output-type',
				fileFormat,
				'--input-type',
				fileFormat,
				tmpEncryptedFilePath,
			],
			{
				...spawnOptions,
				env: {
					EDITOR: fakeDecryptedEditor,
					VSCODE_SOPS_DECRYPTED_FILE_PATH: tmpDecryptedFilePath,
				},
			},
		);
		if (encryptProcess.error) {
			throw encryptProcess.error;
		}
		if (encryptProcess.stderr.toString()) {
			throw new Error(encryptProcess.stderr.toString());
		}
		const encryptedContent = (await fs.readFile(tmpEncryptedFilePath)).toString();
		debug('Encrypted', uri.path, encryptedContent);
		if (!encryptedContent) {
			throw new Error(`Could not decrypt file: ${uri.path}`);
		}
		return encryptedContent;
	} finally {
		await fs.remove(tmpDecryptedFilePath);
		await fs.remove(tmpEncryptedFilePath);
	}
}

async function fileExists(uri: vscode.Uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		return false;
	}
}

export function activate(context: vscode.ExtensionContext) {
	debug('SOPS activated');

	let lastActiveEditor: vscode.TextEditor | undefined;

	vscode.window.onDidChangeActiveTextEditor(async (editor) => {
		debug('change active editor', editor?.document.fileName);
		if (lastActiveEditor) {
			const document = lastActiveEditor.document;
			try {
				if (path.basename(document.uri.path).startsWith(DECRYPTED_PREFIX)) {
					if (document.languageId === 'yaml' || document.languageId === 'json') {
						await closeFile(document.uri);
					}
				}
			} catch (error) {
				debug('Cannot close file', document.fileName, error.message);
			}
		}
		lastActiveEditor = editor;
	});
	vscode.workspace.onDidOpenTextDocument(async (document) => {
		debug('open document', document.fileName);
		try {
			if (document.languageId === 'yaml') {
				await handleFile(document, 'yaml');
			} else if (document.languageId === 'json') {
				await handleFile(document, 'json');
			}
			// TODO dotenv
		} catch (error) {
			debug('Cannot parse file', document.fileName, error.message);
		}
	});

	let disposable = vscode.commands.registerCommand('extension.sops', () => {
		vscode.window.showInformationMessage('SOPS!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
