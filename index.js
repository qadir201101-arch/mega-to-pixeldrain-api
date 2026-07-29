const express = require('express');
const cors = require('cors');
const { File } = require('megajs');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

const SPAM_KEYWORDS = [
    "@onlyfansversedrops", "[telegram]", "joinournetwork", "replacement_image", "t.me"
];
const INVALID_EXTS = [".txt", ".url", ".html", ".exe", ".bat"];

function getAllFiles(node) {
    let files = [];
    if (node.children) {
        for (const child of node.children) {
            if (child.directory) {
                files = files.concat(getAllFiles(child));
            } else {
                files.push(child);
            }
        }
    }
    return files;
}

app.post('/transfer', async (req, res) => {
    try {
        const url = req.body.mega_url;
        if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
        
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
        let fileCount = 1;
        
        for (const file of filesToDownload) {
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
                continue;
            }
            
            const ext = path.extname(file.name);
            const newName = `onlymegalover.com_${fileCount}${ext}`;
            fileCount++;
            
            console.log(`Downloading: ${newName}`);
            const tempPath = path.join(os.tmpdir(), newName);
            
            const stream = file.download();
            const writeStream = fs.createWriteStream(tempPath);
            await new Promise((resolve, reject) => {
                stream.pipe(writeStream);
                stream.on('end', resolve);
                stream.on('error', reject);
                writeStream.on('error', reject);
            });
            
            console.log(`Uploading: ${newName}`);
            const form = new FormData();
            form.append('file', fs.createReadStream(tempPath));
            
            try {
                const uploadResponse = await axios.post('https://pixeldrain.com/api/file', form, {
                    headers: form.getHeaders(),
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                });
                
                if (uploadResponse.status === 201) {
                    uploadedIds.push(uploadResponse.data.id);
                    console.log(`Successfully uploaded: ${uploadResponse.data.id}`);
                }
            } catch (err) {
                console.error(`Failed to upload ${newName}:`, err.message);
            }
            
            try {
                fs.unlinkSync(tempPath);
            } catch(e) {}
        }
        
        if (uploadedIds.length === 0) {
            return res.json({ success: false, error: "No valid files found to upload" });
        }
        
        const listResponse = await axios.post('https://pixeldrain.com/api/list', {
            title: "onlymegalover.com",
            anonymous: true,
            files: uploadedIds.map(id => ({ id }))
        });
        
        if (listResponse.status === 201) {
            return res.json({ success: true, pixeldrain_url: `https://pixeldrain.com/l/${listResponse.data.id}`, files_uploaded: uploadedIds.length });
        } else {
            return res.json({ success: true, pixeldrain_url: `https://pixeldrain.com/u/${uploadedIds[0]}`, files_uploaded: uploadedIds.length });
        }
        
    } catch (error) {
        console.error(error);
        return res.json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Node Server running on port ${PORT}`);
});
