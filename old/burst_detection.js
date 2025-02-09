import WebSocket, { WebSocketServer } from 'ws';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import express from 'express';
import * as helper from './helper.js';

const app = express();
const port = 8080;
// set the view engine to ejs
app.set('view engine', 'ejs');

//const compressedData = fs.readFileSync('./compressed.zst');
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('zstd_dictionary'));

const ws = new WebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.*&compress=true`);
const label_filters = ['porn', 'sexual', 'graphic-media', 'nudity']

// Store the hashtag usage over time
let hashtagCounts = {};  // { hashtag: { timestamp: count, timestamp: count, ... } }
let windowSize = 60000; // 60 seconds window for burst detection
let burstThreshold = 2;  // Consider a burst if count is twice as much as average
const maxTrendingHashtags = 25;  // The number of top trending hashtags to track
let activeBursts = new Map();
let hashtagTrending = new Map();
const decayRate = 0.1; // Decay rate constant for exponential decay
let events = 0;

// Function to extract hashtags from a tweet's text
function extractHashtags(text) {
    const regex = /#(\w+)/g;
    let hashtags = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        hashtags.push(match[0].toLowerCase()); // Ensure case insensitivity
    }

    return hashtags;
}

/// Function to detect bursts for a specific hashtag
function detectBurst(hashtag, currentTime) {
    const recentTimestamps = hashtagCounts[hashtag];

    if (recentTimestamps.length < 2) {
        // Not enough data for burst detection
        return;
    }

    // Calculate the average rate of usage of the hashtag in the time window
    const firstTimestamp = recentTimestamps[0];
    const timeWindow = currentTime - firstTimestamp;
    const averageRate = recentTimestamps.length / timeWindow;

    // If the frequency of this hashtag is more than twice the average, it's a burst
    if (recentTimestamps.length > averageRate * burstThreshold) {
        // Check if this burst is already tracked
        if (!activeBursts.has(hashtag)) {
        
            // Start a new burst
            activeBursts.set(hashtag, {
                startTime: currentTime,
                peakFrequency: recentTimestamps.length,
                lastChecked: currentTime,
            });

            console.log(`New burst detected for hashtag: ${hashtag}`);
        
        } else {

            // Decay the peak frequency over time using exponential decay
            const burst = activeBursts.get(hashtag);
            const timeElapsed = (currentTime - burst.lastChecked) / 1000; // Convert to seconds
            const decayedPeak = burst.peakFrequency * Math.exp(-decayRate * timeElapsed);

            // Update the burst peak frequency considering decay
            if (recentTimestamps.length > decayedPeak) {
                burst.peakFrequency = recentTimestamps.length; // New peak frequency
            } else {
                burst.peakFrequency = decayedPeak; // Apply decayed peak
            }

            // Update the last checked time
            burst.lastChecked = currentTime;

        }
    } else {
        // If a hashtag is not in burst, decay its peak frequency smoothly
        if (activeBursts.has(hashtag)) {

            const burst = activeBursts.get(hashtag);
            const timeElapsed = (currentTime - burst.lastChecked) / 1000; // Convert to seconds
            burst.peakFrequency *= Math.exp(-decayRate * timeElapsed); // Decay the peak frequency over time
            burst.lastChecked = currentTime; // Update the last checked time
    
        }
    }
}

// Function to update the trending hashtags
function updateTrendingHashtags(hashtag) {
    const currentCount = hashtagCounts[hashtag].length;
    hashtagTrending.set(hashtag, currentCount);

    // Sort hashtags by count and keep only the top trending ones
    let sortedHashtags = Array.from(hashtagTrending.entries())
        .sort((a, b) => b[1] - a[1])  // Sort by count, descending
        .slice(0, maxTrendingHashtags);  // Limit to top `maxTrendingHashtags` hashtags

    // Rebuild the trending map
    hashtagTrending.clear();
    sortedHashtags.forEach(([hashtag, count]) => {
        hashtagTrending.set(hashtag, count);
    });
}

ws.on('message', function message(data) {

    const eventdata = JSON.parse(dec.decompress(data).toString());
    
    // get valid commits
    if(!eventdata.commit 
        || !eventdata.commit.record
        || !eventdata.commit.record.text
        || eventdata.commit.record.text == ''
        || eventdata.commit.record.langs == undefined
        || eventdata.commit.record.langs[0] != 'en'
        || eventdata.commit.record.langs.length > 1){
        return;
    }

    // attempt to ignore nsfw posts
    if(eventdata.commit.record.labels){
        
        console.log(eventdata.commit.record.labels.values[0])

        if(label_filters.includes(eventdata.commit.record.labels.values[0].val)){
            console.log("rejected nsfw")
            return
            
        }
        console.log(eventdata.commit.record.labels)
        process.exit();

    } 

    const text = eventdata.commit.record.text;
    // Extract hashtags from the tweet
    const hashtags = extractHashtags(text);

    const currentTime = Date.now();

    hashtags.forEach(hashtag => {
        if (!hashtagCounts[hashtag]) {
            hashtagCounts[hashtag] = [];
        }
        
        // Remove hashtags older than the time window (to keep the sliding window)
        hashtagCounts[hashtag] = hashtagCounts[hashtag].filter(timestamp => currentTime - timestamp <= windowSize);

        // Add the current timestamp for this hashtag
        hashtagCounts[hashtag].push(currentTime);

        // Detect and store bursts, if any
        detectBurst(hashtag, currentTime);

        // Update trending hashtags (you can sort hashtags based on count)
        updateTrendingHashtags(hashtag);
    });
    events++;


});

// Index route
app.get('/', (req, res) => {

    var sorted_bursts = Array.from(activeBursts, ([name, value]) => ({ name, value }))
    sorted_bursts.sort((A, B) => B.value.peakFrequency - A.value.peakFrequency);
    sorted_bursts = sorted_bursts.slice(0,maxTrendingHashtags)

    res.render("pages/index",
        {
            events: events,
            sorted_bursts: sorted_bursts,
        }
    );

});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});