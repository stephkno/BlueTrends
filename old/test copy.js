import WebSocket, { WebSocketServer } from 'ws';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import express from 'express';
import * as helper from '../helper.js';


// runs out of memory

const app = express();
const port = 8080;
// set the view engine to ejs
app.set('view engine', 'ejs');

//const compressedData = fs.readFileSync('./compressed.zst');
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('zstd_dictionary'));

const ws = new WebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?cursor=0&?wantedCollections=app.bsky.feed.*&compress=true`);

// Define the size of the sliding window and burst threshold multiplier
const WINDOW_SIZE = 50000;  // Number of past tweets to consider in the window
const THRESHOLD_MULTIPLIER = 3;  // Burst detection threshold (e.g., 2x the moving average)
let ema = 0;  // Exponential moving average
const EMA_SMOOTHING_FACTOR = 0.1;  // Adjust to give more weight to recent data

// Data structure to store keyword frequencies in the sliding window
let burstFrequency = {};  // Tracks the frequency of keywords in the current window
let keywordFrequency = {};  // Tracks the frequency of keywords in the current window
let slidingWindow = [];  // Keeps track of keyword frequencies in the last 24 hours
const label_filters = ['porn', 'sexual', 'graphic-media', 'nudity']

// Function to extract hashtags (or any keywords) from the tweet text
function extractKeywords(text) {
    const hashtags = text.match(/#\w+/g);  // Example: Extract hashtags
    return hashtags || [];  // Return an array of hashtags, or empty array if none
}

function detectBurst(keyword) {

    const currentFrequency = keywordFrequency[keyword] || 0;

    // Calculate the EMA for the keyword frequency
    ema = EMA_SMOOTHING_FACTOR * currentFrequency + (1 - EMA_SMOOTHING_FACTOR) * ema;
    
    // Define burst detection threshold
    const threshold = THRESHOLD_MULTIPLIER * ema;  // Threshold is 2x the EMA of past frequency

    // If the frequency exceeds the threshold, it's a burst
    if (currentFrequency > threshold) {
        
        console.log(`Burst detected: ${keyword}:${currentFrequency}`);
        if (!burstFrequency[keyword]) {
            burstFrequency[keyword] = 0;
        }
        burstFrequency[keyword] += 1;
    }

}

ws.on('message', function message(data) {

    const eventdata = JSON.parse(dec.decompress(data).toString());
    
    // get valid commits
    if(!eventdata.commit 
        || !eventdata.commit.record
        || eventdata.commit.record.text == ''
        || eventdata.commit.record.langs == undefined
        || eventdata.commit.record.langs[0] != 'en'
        || eventdata.commit.record.langs.length > 1){
        return;
    }

    // attempt to ignore nsfw posts
    if(eventdata.commit.record.labels){

        if(label_filters.includes(eventdata.commit.record.labels.values[0].val)){
            //console.log("rejected nsfw")
            return
            
        }
        console.log(eventdata.commit.record.labels)

    } 

    const tweet = eventdata.commit.record.text;

    // Extract keywords (e.g., hashtags)
    const keywords = extractKeywords(tweet);
    
    // Update keyword frequencies for this tweet
    keywords.forEach(keyword => {
        
        keyword.toLowerCase();
        
        if (!keywordFrequency[keyword]) {
            keywordFrequency[keyword] = 0;
        }
        keywordFrequency[keyword] += 1;
    });

    // Add this tweet's keyword frequency to the sliding window
    slidingWindow.push({...keywordFrequency});  // Make a copy of the current frequencies
    const sw_l = slidingWindow.length
    
    // Keep the sliding window within the defined size (e.g., 5 tweets)
    if (sw_l > WINDOW_SIZE) {
        slidingWindow.shift();  // Remove the oldest frequency record from the window
    }
    // Now check for bursts on all the keywords
    keywords.forEach(keyword => {
        detectBurst(keyword);
    });

});

// Index route
app.get('/', (req, res) => {

    var top_bursts = Object.entries(burstFrequency);

    top_bursts.sort(([, A], [, B]) => B - A);

    res.send(top_bursts)
    
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});