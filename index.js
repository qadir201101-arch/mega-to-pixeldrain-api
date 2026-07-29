const express = require('express');
const cors = require('cors');
const { File } = require('megajs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const API_KEY = '27582c8d-92da-4cd9-b014-c30db0e905be';

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

function getAllFiles(node, currentPath = "") {
    let files = [];
    if (node.children) {
        for (const child of node.children) {
            if (child.directory) {
                const newPath = currentPath ? `${currentPath} - ${child.name}` : child.name;
                files = files.concat(getAllFiles(child, newPath));
            } else {
                child.customPathName = currentPath ? `${currentPath} - ${child.name}` : child.name;
                files.push(child);
            }
        }
    }
    return files;
}

app.post('/transfer', async (req, res) => {
    // 🚀 Bypassing Render's 100-second idle timeout
    // We send a space character every 10 seconds. This keeps the connection active.
    // The browser's res.json() will just ignore leading whitespace and parse the final JSON.
    res.setHeader('Content-Type', 'application/json');
    const keepAlive = setInterval(() => {
        res.write(' ');
    }, 10000);

    try {
        const url = req.body.mega_url;
        if (!url) {
            clearInterval(keepAlive);
            res.write(JSON.stringify({ success: false, error: "No URL provided" }));
            return res.end();
        }
        
        console.log(`Starting transfer for: ${url}`);
        const megaObj = File.fromURL(url);
        await megaObj.loadAttributes();
        
        let filesToDownload = [];
        if (megaObj.directory) {
            filesToDownload = getAllFiles(megaObj);
        } else {
            filesToDownload = [megaObj];
        }
        
        let uploadedIds = [];
        
        async function processFile(file) {
            const lowerName = file.name.toLowerCase();
            let isSpam = false;
            
            for (const word of SPAM_KEYWORDS) {
                if (lowerName.includes(word)) isSpam = true;
            }
            for (const ext of INVALID_EXTS) {
                if (lowerName.endsWith(ext)) isSpam = true;
            }
            
            if (isSpam) {
                console.log(`Skipping spam: ${file.name}`);
                return null;
            }
            
            let newName = file.customPathName || file.name;
            
            // Replace promotional names with your website name
            for (const promo of PROMO_KEYWORDS) {
                const regex = new RegExp(promo, "gi");
                newName = newName.replace(regex, "onlymegalovers.com");
            }
            
            console.log(`Streaming directly from Mega to Pixeldrain: ${newName}`);
            
            try {
                const stream = file.download();
                const form = new FormData();
                form.append('file', stream, { filename: newName, knownLength: file.size });
                
                const uploadResponse = await axios.post('https://pixeldrain.com/api/file', form, {
                    headers: form.getHeaders(),
                    auth: { username: '', password: API_KEY },
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

        // Process files in PARALLEL (4 at a time) for massive speed boost!
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
            res.write(JSON.stringify({ success: false, error: "No valid files found to upload" }));
            return res.end();
        }
        
        const postTitle = req.body.post_title;
        const folderTitle = postTitle || megaObj.name || "onlymegalover.com";
        const listResponse = await axios.post('https://pixeldrain.com/api/list', {
            title: folderTitle,
            anonymous: false,
            files: uploadedIds.map(id => ({ id }))
        }, {
            auth: { username: '', password: API_KEY }
        });
        
        if (listResponse.status === 201) {
            res.write(JSON.stringify({ success: true, pixeldrain_url: `https://pixeldrain.com/l/${listResponse.data.id}`, files_uploaded: uploadedIds.length }));
        } else {
            res.write(JSON.stringify({ success: true, pixeldrain_url: `https://pixeldrain.com/u/${uploadedIds[0]}`, files_uploaded: uploadedIds.length }));
        }
        res.end();
        
    } catch (error) {
        clearInterval(keepAlive);
        console.error(error);
        res.write(JSON.stringify({ success: false, error: error.message }));
        res.end();
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Node Server running on port ${PORT}`);
});
