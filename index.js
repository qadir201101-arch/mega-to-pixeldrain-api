const express = require('express');
const cors = require('cors');
const { File } = require('megajs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const SPAM_KEYWORDS = [
    "telegram", "joinournetwork", "replacement_image", "t.me"
];
const PROMO_KEYWORDS = [
    "@onlyfansversedrops", "of verses"
];
const INVALID_EXTS = [".txt", ".url", ".html", ".exe", ".bat"];
const PIXELDRAIN_API_KEY = "27582c8d-92da-4cd9-b014-c30db0e905be";

// Recursively fetch all files for Pixeldrain (flat list with path in names)
function getPixeldrainFiles(node, currentPath = "") {
    let files = [];
    if (node.children) {
        for (const child of node.children) {
            if (child.directory) {
                const newPath = currentPath ? `${currentPath} - ${child.name}` : child.name;
                files = files.concat(getPixeldrainFiles(child, newPath));
            } else {
                child.customPathName = currentPath ? `${currentPath} - ${child.name}` : child.name;
                files.push(child);
            }
        }
    }
    return files;
}

// Clean names for SPAM and PROMO
function cleanFileName(name) {
    let newName = name;
    for (const promo of PROMO_KEYWORDS) {
        const regex = new RegExp(promo, "gi");
        newName = newName.replace(regex, "onlymegalovers.com");
    }
    return newName;
}

function isSpamFile(name) {
    const lowerName = name.toLowerCase();
    for (const word of SPAM_KEYWORDS) {
        if (lowerName.includes(word)) return true;
    }
    for (const ext of INVALID_EXTS) {
        if (lowerName.endsWith(ext)) return true;
    }
    return false;
}

// --- Pixeldrain Logic ---
async function handlePixeldrainTransfer(megaObj, postTitle, res, keepAlive) {
    const filesToDownload = getPixeldrainFiles(megaObj);
    if (filesToDownload.length === 0) {
        clearInterval(keepAlive);
        return res.status(400).json({ error: 'No files found in the Mega folder.' });
    }

    let uploadedIds = [];
    
    async function processFile(file) {
        if (isSpamFile(file.name)) {
            console.log(`Skipping spam: ${file.name}`);
            return null;
        }
        
        const newName = cleanFileName(file.customPathName || file.name);
        console.log(`Streaming directly from Mega to Pixeldrain: ${newName}`);
        
        try {
            const stream = file.download();
            const form = new FormData();
            form.append('file', stream, { filename: newName, knownLength: file.size });
            
            const uploadResponse = await axios.post('https://pixeldrain.com/api/file', form, {
                headers: form.getHeaders(),
                auth: { username: '', password: PIXELDRAIN_API_KEY },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
            });
            
            if (uploadResponse.status === 201) {
                console.log(`Successfully uploaded: ${uploadResponse.data.id}`);
                return uploadResponse.data.id;
            }
        } catch (err) {
            console.error(`Failed to upload ${newName}:`, err.message);
        }
        return null;
    }

    const CONCURRENCY = 4;
    for (let i = 0; i < filesToDownload.length; i += CONCURRENCY) {
        const chunk = filesToDownload.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(file => processFile(file)));
        for (const id of results) {
            if (id) uploadedIds.push(id);
        }
    }
    
    clearInterval(keepAlive);
    
    if (uploadedIds.length === 0) {
        res.write(JSON.stringify({ error: "Failed to upload any files to Pixeldrain" }));
        return res.end();
    }
    
    const folderTitle = postTitle || megaObj.name || "onlymegalover.com";
    const listResponse = await axios.post('https://pixeldrain.com/api/list', {
        title: folderTitle,
        anonymous: false,
        files: uploadedIds.map(id => ({ id }))
    }, {
        auth: { username: '', password: PIXELDRAIN_API_KEY }
    });
    
    res.write(JSON.stringify({
        success: true,
        url: `https://pixeldrain.com/l/${listResponse.data.id}`
    }));
    return res.end();
}

// --- Gofile Logic ---
async function createGofileFolder(parentFolderId, folderName, token) {
    const cleanName = cleanFileName(folderName);
    const res = await axios.post("https://api.gofile.io/contents/createFolder", {
        parentFolderId: parentFolderId,
        folderName: cleanName
    }, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    return res.data.data;
}

async function uploadToGofile(stream, filename, size, folderId, token, server) {
    const form = new FormData();
    form.append('token', token);
    form.append('folderId', folderId);
    form.append('file', stream, { filename: filename, knownLength: size });
    
    const uploadRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, form, {
        headers: {
            ...form.getHeaders(),
            'Authorization': `Bearer ${token}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
    });
    return uploadRes.data.data;
}

// Recursively traverse Mega and map to Gofile
async function mapMegaToGofile(megaNode, gofileParentId, token, server) {
    const CONCURRENCY = 4;
    let filesInCurrentNode = [];
    
    // First, process all children
    for (const child of megaNode.children || []) {
        if (child.directory) {
            if (isSpamFile(child.name)) continue;
            
            console.log(`Creating Gofile directory for ${child.name}`);
            const gfFolder = await createGofileFolder(gofileParentId, child.name, token);
            await mapMegaToGofile(child, gfFolder.id, token, server);
        } else {
            if (!isSpamFile(child.name)) {
                filesInCurrentNode.push(child);
            }
        }
    }
    
    // Upload files in the current folder concurrently
    const CONCURRENCY_GOFILE = 2; // Reduced to prevent rate limits
    for (let i = 0; i < filesInCurrentNode.length; i += CONCURRENCY_GOFILE) {
        const chunk = filesInCurrentNode.slice(i, i + CONCURRENCY_GOFILE);
        const promises = chunk.map(async (file) => {
            const cleanName = cleanFileName(file.name);
            console.log(`Streaming to Gofile: ${cleanName}`);
            let retries = 3;
            while (retries > 0) {
                try {
                    await uploadToGofile(file.download(), cleanName, file.size, gofileParentId, token, server);
                    console.log(`Successfully uploaded to Gofile: ${cleanName}`);
                    break;
                } catch(e) {
                    retries--;
                    console.error(`Failed Gofile upload for ${cleanName} (${3-retries}/3):`, e.message);
                    if (retries === 0) {
                        console.error(`Giving up on ${cleanName}`);
                    } else {
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
            }
        });
        await Promise.all(promises);
    }
}

async function handleGofileTransfer(megaObj, postTitle, res, keepAlive) {
    try {
        console.log("Setting up Gofile Guest Account...");
        const accRes = await axios.post("https://api.gofile.io/accounts");
        const token = accRes.data.data.token;
        const rootFolder = accRes.data.data.rootFolder;
        
        console.log("Fetching best Gofile server...");
        const serverRes = await axios.get("https://api.gofile.io/servers");
        const server = serverRes.data.data.servers[0].name;
        
        const folderTitle = postTitle || megaObj.name || "onlymegalover.com";
        console.log("Creating Main Folder:", folderTitle);
        const mainFolder = await createGofileFolder(rootFolder, folderTitle, token);
        const mainFolderId = mainFolder.id;
        const mainFolderCode = mainFolder.code;
        
        // Make the main folder public so viewers can access it without issues
        try {
            await axios.put(`https://api.gofile.io/contents/${mainFolderId}/update`, {
                attribute: "public",
                attributeValue: "true"
            }, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            console.log("Main folder set to public.");
        } catch (err) {
            console.error("Warning: Failed to set folder to public", err.message);
        }
        
        // Start traversing Mega tree
        await mapMegaToGofile(megaObj, mainFolderId, token, server);
        
        clearInterval(keepAlive);
        res.write(JSON.stringify({
            success: true,
            url: `https://gofile.io/d/${mainFolderCode}`
        }));
        return res.end();
        
    } catch (e) {
        clearInterval(keepAlive);
        console.error("Gofile transfer error:", e.response ? e.response.data : e.message);
        res.write(JSON.stringify({ error: e.message }));
        return res.end();
    }
}

app.post('/transfer', async (req, res) => {
    // Keep Render connection alive
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    const keepAlive = setInterval(() => {
        res.write(' ');
    }, 20000);
    
    const megaUrl = req.body.mega_url;
    const postTitle = req.body.post_title;
    const provider = req.body.provider || "gofile"; // Default to gofile if not specified
    
    if (!megaUrl) {
        clearInterval(keepAlive);
        return res.status(400).json({ error: 'mega_url is required' });
    }
    
    try {
        console.log(`Loading Mega Node for URL: ${megaUrl} (Provider: ${provider})`);
        const megaObj = File.fromURL(megaUrl);
        await megaObj.loadAttributes();
        
        if (provider === "pixeldrain") {
            await handlePixeldrainTransfer(megaObj, postTitle, res, keepAlive);
        } else {
            await handleGofileTransfer(megaObj, postTitle, res, keepAlive);
        }
        
    } catch (error) {
        clearInterval(keepAlive);
        console.error("Mega load error:", error);
        res.write(JSON.stringify({ error: 'Failed to access Mega link. It might be invalid, empty, or password protected.' }));
        return res.end();
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
