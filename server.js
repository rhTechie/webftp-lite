const express = require('express');
const { Client } = require('basic-ftp');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`FTP Web Tool 运行在: http://0.0.0.0:${PORT}`);
  console.log(`局域网访问: http://<你的IP>:${PORT}`);
});

const wss = new WebSocket.Server({ server });

// 存储每个WebSocket连接对应的FTP客户端
const ftpClients = new Map();

wss.on('connection', (ws) => {
  console.log('新的WebSocket连接');

  const client = new Client();
  client.ftp.verbose = false;
  ftpClients.set(ws, client);

  // 存储连接信息用于重连
  let connectionInfo = null;

  // 添加请求队列，确保操作按顺序执行
  let processing = false;
  const queue = [];

  // 检查并重连FTP
  const ensureConnected = async () => {
    if (!client.closed) return true;

    if (!connectionInfo) {
      throw new Error('连接已断开，请重新连接');
    }

    console.log('FTP连接已断开，尝试重连...');
    try {
      await client.access(connectionInfo);
      console.log('重连成功');
      return true;
    } catch (error) {
      console.log('重连失败:', error.message);
      throw new Error('连接已断开且重连失败，请刷新页面重新连接');
    }
  };

  const processQueue = async () => {
    if (processing || queue.length === 0) return;
    processing = true;

    while (queue.length > 0) {
      const { data, resolve } = queue.shift();
      try {
        const { action, payload } = data;

        // 除了connect和disconnect，其他操作都需要确保连接
        if (action !== 'connect' && action !== 'disconnect') {
          await ensureConnected();
        }

        switch (action) {
          case 'connect':
            connectionInfo = {
              host: payload.host,
              port: payload.port || 21,
              user: payload.user,
              password: payload.password,
              secure: false
            };
            await handleConnect(ws, client, payload);
            break;
          case 'list':
            await handleList(ws, client, payload);
            break;
          case 'download':
            await handleDownload(ws, client, payload);
            break;
          case 'upload':
            await handleUpload(ws, client, payload);
            break;
          case 'delete':
            await handleDelete(ws, client, payload);
            break;
          case 'rename':
            await handleRename(ws, client, payload);
            break;
          case 'mkdir':
            await handleMkdir(ws, client, payload);
            break;
          case 'disconnect':
            client.close();
            connectionInfo = null;
            ws.send(JSON.stringify({ type: 'success', message: '已断开连接' }));
            break;
        }
        resolve();
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
        resolve();
      }
    }

    processing = false;
  };

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await new Promise((resolve) => {
        queue.push({ data, resolve });
        processQueue();
      });
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    console.log('WebSocket连接关闭');
    client.close();
    ftpClients.delete(ws);
  });
});

async function handleConnect(ws, client, payload) {
  const { host, port, user, password } = payload;
  try {
    await client.access({
      host: host,
      port: port || 21,
      user: user,
      password: password,
      secure: false
    });
    ws.send(JSON.stringify({ type: 'connected', message: '连接成功' }));
    // 连接成功后自动列出根目录
    await handleList(ws, client, { path: '/' });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `连接失败: ${error.message}` }));
  }
}

async function handleList(ws, client, payload) {
  const { path: dirPath } = payload;
  try {
    const list = await client.list(dirPath || '/');
    const files = list.map(item => ({
      name: item.name,
      type: item.isDirectory ? 'directory' : 'file',
      size: item.size,
      date: item.modifiedAt
    }));
    ws.send(JSON.stringify({ type: 'list', data: files, path: dirPath || '/' }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `列出目录失败: ${error.message}` }));
  }
}

async function handleDownload(ws, client, payload) {
  const { path: filePath } = payload;
  try {
    const fs = require('fs');
    const localPath = `/tmp/${path.basename(filePath)}`;
    await client.downloadTo(localPath, filePath);

    // 读取文件并发送
    const fileData = fs.readFileSync(localPath);
    ws.send(JSON.stringify({
      type: 'download',
      data: fileData.toString('base64'),
      filename: path.basename(filePath)
    }));

    // 删除临时文件
    fs.unlinkSync(localPath);
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `下载失败: ${error.message}` }));
  }
}

async function handleUpload(ws, client, payload) {
  const { path: remotePath, data, filename } = payload;
  try {
    const fs = require('fs');
    const localPath = `/tmp/${filename}`;

    // 将base64数据写入临时文件
    fs.writeFileSync(localPath, Buffer.from(data, 'base64'));

    // 上传到FTP服务器
    await client.uploadFrom(localPath, `${remotePath}/${filename}`);

    // 删除临时文件
    fs.unlinkSync(localPath);

    ws.send(JSON.stringify({ type: 'success', message: '上传成功' }));
    // 刷新目录列表
    await handleList(ws, client, { path: remotePath });
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `上传失败: ${error.message}` }));
  }
}

async function handleDelete(ws, client, payload) {
  const { path: filePath, type } = payload;
  try {
    if (type === 'directory') {
      await client.removeDir(filePath);
    } else {
      await client.remove(filePath);
    }
    ws.send(JSON.stringify({ type: 'success', message: '删除成功' }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `删除失败: ${error.message}` }));
  }
}

async function handleRename(ws, client, payload) {
  const { oldPath, newPath } = payload;
  try {
    await client.rename(oldPath, newPath);
    ws.send(JSON.stringify({ type: 'success', message: '重命名成功' }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `重命名失败: ${error.message}` }));
  }
}

async function handleMkdir(ws, client, payload) {
  const { path: dirPath } = payload;
  try {
    await client.ensureDir(dirPath);
    ws.send(JSON.stringify({ type: 'success', message: '创建目录成功' }));
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: `创建目录失败: ${error.message}` }));
  }
}
