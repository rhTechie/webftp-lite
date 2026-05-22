let ws = null;
let currentPath = '/';
let isConnected = false;

document.addEventListener('DOMContentLoaded', initializeApp);

async function initializeApp() {
    await loadDefaultConfig();
}

async function loadDefaultConfig() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) {
            throw new Error('加载默认配置失败');
        }

        const config = await response.json();
        const ftpDefaults = config.ftpDefaults || {};

        document.getElementById('host').value = ftpDefaults.host || '';
        document.getElementById('port').value = ftpDefaults.port || 21;
        document.getElementById('user').value = ftpDefaults.user || 'root';
        document.getElementById('password').value = ftpDefaults.password || 'root';
    } catch (error) {
        updateStatus('默认配置加载失败，已使用页面内默认值');
    }
}

function connect() {
    const host = document.getElementById('host').value;
    const port = document.getElementById('port').value;
    const user = document.getElementById('user').value;
    const password = document.getElementById('password').value;

    if (!host || !user || !password) {
        alert('请填写完整的连接信息');
        return;
    }

    updateStatus('正在连接...');

    // 获取当前页面的协议和主机
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host;

    ws = new WebSocket(`${protocol}//${wsHost}`);

    ws.onopen = () => {
        ws.send(JSON.stringify({
            action: 'connect',
            payload: { host, port: parseInt(port), user, password }
        }));
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleMessage(message);
    };

    ws.onerror = (error) => {
        updateStatus('连接错误');
        alert('WebSocket连接失败');
    };

    ws.onclose = () => {
        isConnected = false;
        updateStatus('连接已断开');
        showConnectionPanel();
    };
}

function handleMessage(message) {
    switch (message.type) {
        case 'connected':
            isConnected = true;
            updateStatus('已连接');
            showFilePanel();
            break;
        case 'list':
            currentPath = message.path;
            document.getElementById('currentPath').value = currentPath;
            renderFileList(message.data);
            break;
        case 'success':
            updateStatus(message.message);
            if (message.refreshList !== false) {
                refreshList();
            }
            break;
        case 'error':
            updateStatus('错误: ' + message.message);
            alert(message.message);
            break;
        case 'download':
            downloadFile(message.filename, message.data);
            updateStatus('下载完成');
            break;
    }
}

function renderFileList(files) {
    const fileList = document.getElementById('fileList');

    let html = '';

    // 如果不在根目录，添加返回上级目录选项
    if (currentPath !== '/') {
        html += `
            <div class="file-item" onclick="goToParent()">
                <div class="file-icon">⬆️</div>
                <div class="file-info">
                    <div class="file-name">..</div>
                    <div class="file-meta">返回上级目录</div>
                </div>
            </div>
        `;
    }

    if (files.length === 0) {
        if (html === '') {
            // 根目录且为空
            fileList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📂</div>
                    <div>此目录为空</div>
                </div>
            `;
        } else {
            // 非根目录且为空，但已经有返回上级的选项
            fileList.innerHTML = html + `
                <div class="empty-state">
                    <div class="empty-state-icon">📂</div>
                    <div>此目录为空</div>
                </div>
            `;
        }
        return;
    }

    // 先显示目录，再显示文件
    const dirs = files.filter(f => f.type === 'directory');
    const regularFiles = files.filter(f => f.type === 'file');

    [...dirs, ...regularFiles].forEach(file => {
        const icon = file.type === 'directory' ? '📁' : '📄';
        const size = file.type === 'file' ? formatSize(file.size) : '';
        const date = file.date ? new Date(file.date).toLocaleString('zh-CN') : '';

        html += `
            <div class="file-item">
                <div class="file-icon">${icon}</div>
                <div class="file-info" onclick='${file.type === 'directory' ? `openDirectory("${file.name}")` : ''}'>
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-meta">${size} ${date}</div>
                </div>
                <div class="file-actions">
                    ${file.type === 'file' ? `<button onclick='downloadFileFromFTP("${file.name}")'>下载</button>` : ''}
                    <button class="delete-btn" onclick='deleteItem("${file.name}", "${file.type}")'>删除</button>
                </div>
            </div>
        `;
    });

    fileList.innerHTML = html;
}

function openDirectory(name) {
    const newPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    ws.send(JSON.stringify({
        action: 'list',
        payload: { path: newPath }
    }));
}

function goToParent() {
    const parts = currentPath.split('/').filter(p => p);
    parts.pop();
    const newPath = parts.length === 0 ? '/' : '/' + parts.join('/');
    ws.send(JSON.stringify({
        action: 'list',
        payload: { path: newPath }
    }));
}

function goToPath() {
    const path = document.getElementById('currentPath').value;
    ws.send(JSON.stringify({
        action: 'list',
        payload: { path: path }
    }));
}

function refreshList() {
    if (!isConnected) return;
    ws.send(JSON.stringify({
        action: 'list',
        payload: { path: currentPath }
    }));
}

function downloadFileFromFTP(filename) {
    const filePath = currentPath === '/' ? `/${filename}` : `${currentPath}/${filename}`;
    updateStatus('正在下载...');
    ws.send(JSON.stringify({
        action: 'download',
        payload: { path: filePath }
    }));
}

function downloadFile(filename, base64Data) {
    const link = document.createElement('a');
    link.href = 'data:application/octet-stream;base64,' + base64Data;
    link.download = filename;
    link.click();
}

function showUploadDialog() {
    resetUploadInputs();
    document.getElementById('uploadModal').classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

function handleUploadSelection(type) {
    if (type === 'file') {
        document.getElementById('directoryInput').value = '';
        return;
    }

    document.getElementById('fileInput').value = '';
}

function resetUploadInputs() {
    document.getElementById('fileInput').value = '';
    document.getElementById('directoryInput').value = '';
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result.split(',')[1]);
        };
        reader.onerror = () => {
            reject(new Error(`读取文件失败: ${file.name}`));
        };
        reader.readAsDataURL(file);
    });
}

async function uploadFiles() {
    const fileInput = document.getElementById('fileInput');
    const directoryInput = document.getElementById('directoryInput');
    const directoryFiles = Array.from(directoryInput.files);
    const selectedFiles = directoryFiles.length > 0
        ? directoryFiles
        : Array.from(fileInput.files);
    const isDirectoryUpload = directoryFiles.length > 0;

    if (selectedFiles.length === 0) {
        alert('请选择文件或目录');
        return;
    }

    closeModal('uploadModal');

    try {
        const uploadLabel = isDirectoryUpload ? '目录' : '文件';

        for (let index = 0; index < selectedFiles.length; index += 1) {
            const file = selectedFiles[index];
            const relativePath = isDirectoryUpload
                ? (file.webkitRelativePath || file.name)
                : file.name;
            const base64Data = await readFileAsBase64(file);

            ws.send(JSON.stringify({
                action: 'upload',
                payload: {
                    path: currentPath,
                    filename: file.name,
                    relativePath: relativePath,
                    data: base64Data,
                    refreshList: index === selectedFiles.length - 1
                }
            }));
            updateStatus(`正在上传 (${index + 1}/${selectedFiles.length}) ${relativePath}...`);
        }
        updateStatus(`${uploadLabel}上传请求已发送，正在等待服务器处理...`);
    } catch (error) {
        alert(error.message);
        updateStatus('上传失败');
    } finally {
        resetUploadInputs();
    }
}

function showMkdirDialog() {
    document.getElementById('mkdirModal').classList.add('active');
}

function createDirectory() {
    const dirName = document.getElementById('newDirName').value;
    if (!dirName) {
        alert('请输入文件夹名称');
        return;
    }

    const newPath = currentPath === '/' ? `/${dirName}` : `${currentPath}/${dirName}`;
    ws.send(JSON.stringify({
        action: 'mkdir',
        payload: { path: newPath }
    }));

    closeModal('mkdirModal');
    document.getElementById('newDirName').value = '';
}

function deleteItem(name, type) {
    if (!confirm(`确定要删除 ${name} 吗？`)) {
        return;
    }

    const itemPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
    ws.send(JSON.stringify({
        action: 'delete',
        payload: { path: itemPath, type: type }
    }));
}

function disconnect() {
    if (ws) {
        ws.send(JSON.stringify({ action: 'disconnect' }));
        ws.close();
    }
    showConnectionPanel();
}

function showConnectionPanel() {
    document.getElementById('connectionPanel').style.display = 'block';
    document.getElementById('filePanel').style.display = 'none';
}

function showFilePanel() {
    document.getElementById('connectionPanel').style.display = 'none';
    document.getElementById('filePanel').style.display = 'block';
}

function updateStatus(text) {
    document.getElementById('statusText').textContent = text;
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
