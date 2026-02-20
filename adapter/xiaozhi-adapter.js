/**
 * Xiaozhi Adapter - TƯƠNG THÍCH VỚI CODE ESP32 GỐC
 * Trả về RELATIVE PATH thay vì FULL URL (ESP32 tự ghép base_url)
 */

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 5006;
const MP3_API_URL = process.env.MP3_API_URL || 'http://mp3-api:5555';

// CACHE ĐƠN GIẢN
const audioCache = new Map(); // {songId: Buffer}
const CACHE_MAX_SIZE = 10;

app.get('/stream_pcm', async (req, res) => {
    try {
        let { song, artist = '' } = req.query;

        if (!song) {
            return res.status(400).json({ error: 'Missing song parameter' });
        }

        // Sửa lỗi encoding nếu input bị lỗi (Sóng gió -> SÃ³ng giÃ³)
        try {
            const decodedSong = Buffer.from(song, 'latin1').toString('utf8');
            // Nếu chuỗi sau khi decode có ký tự tiếng Việt hoặc thay đổi, dùng chuỗi đó
            if (decodedSong !== song && /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(decodedSong)) {
                console.log(`📝 Fixed encoding: "${song}" -> "${decodedSong}"`);
                song = decodedSong;
            }
        } catch (e) {
            // Giữ nguyên nếu lỗi
        }

        console.log(`🔍 Searching: "${song}" by "${artist}"`);

        const searchQuery = artist ? `${song} ${artist}` : song;
        const searchUrl = `${MP3_API_URL}/api/search?q=${encodeURIComponent(searchQuery)}`;

        const searchResponse = await axios.get(searchUrl, {
            timeout: 15000,
            headers: { 'User-Agent': 'Xiaozhi-Adapter/1.0' }
        });

        let songs = [];
        if (searchResponse.data.err === 0 &&
            searchResponse.data.data &&
            Array.isArray(searchResponse.data.data.songs)) {
            songs = searchResponse.data.data.songs;
        }

        if (songs.length === 0) {
            return res.status(404).json({
                error: 'Song not found',
                title: song,
                artist: artist || 'Unknown'
            });
        }

        // Thử 3 bài hát đầu tiên
        const topSongs = songs.slice(0, 3);
        console.log(`📖 Checking top ${topSongs.length} results...`);

        const results = [];
        for (const songItem of topSongs) {
            const songId = songItem.encodeId;

            if (!songId) continue;

            console.log(`🎵 Trying: ${songItem.title} (ID: ${songId})`);

            // Pre-download nếu chưa có trong cache
            if (!audioCache.has(songId)) {
                console.log(`⬇️ Pre-downloading audio for ${songId}...`);
                try {
                    const streamUrl = `${MP3_API_URL}/api/song/stream?id=${songId}`;
                    const audioResponse = await axios({
                        method: 'GET',
                        url: streamUrl,
                        responseType: 'arraybuffer',
                        maxRedirects: 5,
                        timeout: 120000,
                        headers: { 'User-Agent': 'Xiaozhi-Adapter/1.0' }
                    });

                    const audioBuffer = Buffer.from(audioResponse.data);
                    console.log(`✅ Downloaded ${audioBuffer.length} bytes`);

                    // Lưu vào cache
                    audioCache.set(songId, audioBuffer);

                    // Giới hạn cache size
                    if (audioCache.size > CACHE_MAX_SIZE) {
                        const firstKey = audioCache.keys().next().value;
                        audioCache.delete(firstKey);
                        console.log(`🗑️ Removed ${firstKey} from cache`);
                    }
                } catch (error) {
                    console.error(`❌ Failed to pre-download ${songId}: ${error.message} ${error.response ? `(Status: ${error.response.status})` : ''}`);
                    continue; // Thử bài tiếp theo
                }
            } else {
                console.log(`✅ Using cached audio for ${songId}`);
            }

            // Gán kết quả nếu tìm thấy bài hát ok
            results.push({
                title: songItem.title || song,
                artist: songItem.artistsNames || artist || 'Unknown',
                audio_url: `/proxy_audio?id=${songId}`,
                lyric_url: `/proxy_lyric?id=${songId}`,
                thumbnail: songItem.thumbnail || songItem.thumbnailM || '',
                duration: songItem.duration || 0,
                language: 'unknown'
            });

            // Tìm thấy một bài là đủ
            break;
        }

        if (results.length === 0) {
            return res.status(500).json({
                error: 'Failed to process any songs',
                detail: 'Could not download audio for any of the search results.'
            });
        }

        const response = results[0];
        console.log(`✅ Success with: ${response.title}`);
        res.json(response);

    } catch (error) {
        console.error('❌ Error:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===== PROXY AUDIO TỪ CACHE =====
app.get('/proxy_audio', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) {
            return res.status(400).send('Missing id parameter');
        }

        console.log(`🎵 Serving audio for song ID: ${id}`);

        // Lấy từ cache
        if (audioCache.has(id)) {
            const audioBuffer = audioCache.get(id);
            console.log(`✅ Serving ${audioBuffer.length} bytes from cache`);

            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Length': audioBuffer.length,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=86400'
            });

            res.send(audioBuffer);
        } else {
            // Nếu không có trong cache, download mới
            console.log(`⚠️ Not in cache, downloading...`);
            const streamUrl = `${MP3_API_URL}/api/song/stream?id=${id}`;

            const audioResponse = await axios({
                method: 'GET',
                url: streamUrl,
                responseType: 'arraybuffer',
                timeout: 120000
            });

            const audioBuffer = Buffer.from(audioResponse.data);
            audioCache.set(id, audioBuffer);

            res.set({
                'Content-Type': 'audio/mpeg',
                'Content-Length': audioBuffer.length,
                'Accept-Ranges': 'bytes'
            });

            res.send(audioBuffer);
        }

    } catch (error) {
        console.error('❌ Proxy audio error:', error.message);
        res.status(500).send('Failed to proxy audio');
    }
});

// ===== PROXY LYRIC =====
app.get('/proxy_lyric', async (req, res) => {
    try {
        const { id } = req.query;
        if (!id) {
            return res.status(400).send('Missing id parameter');
        }

        console.log(`📝 Serving lyric for song ID: ${id}`);

        const lyricUrl = `${MP3_API_URL}/api/lyric?id=${id}`;
        const response = await axios.get(lyricUrl, { timeout: 10000 });

        if (response.data && response.data.err === 0 && response.data.data) {
            const lyricData = response.data.data;

            if (lyricData.file) {
                const lyricContent = await axios.get(lyricData.file);
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(lyricContent.data);
            } else if (Array.isArray(lyricData.sentences)) {
                let lrcContent = '';
                lyricData.sentences.forEach(s => {
                    const words = s.words || [];
                    words.forEach(w => {
                        const time = w.startTime || 0;
                        const minutes = Math.floor(time / 60000);
                        const seconds = Math.floor((time % 60000) / 1000);
                        const ms = Math.floor((time % 1000) / 10);
                        lrcContent += `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(2, '0')}]${w.data}\n`;
                    });
                });
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(lrcContent);
            } else {
                res.status(404).send('Lyric not found');
            }
        } else {
            res.status(404).send('Lyric not found');
        }

    } catch (error) {
        console.error('❌ Proxy lyric error:', error.message);
        res.status(404).send('Lyric not found');
    }
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        cache_size: audioCache.size,
        cached_songs: Array.from(audioCache.keys())
    });
});

app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log(`🎵 Xiaozhi Adapter (ESP32 COMPATIBLE) on port ${PORT}`);
    console.log(`🔗 MP3 API: ${MP3_API_URL}`);
    console.log(`💾 Cache enabled (max ${CACHE_MAX_SIZE} songs)`);
    console.log(`✅ Returns RELATIVE PATHS (ESP32 auto-builds full URL)`);
    console.log('='.repeat(60));
});