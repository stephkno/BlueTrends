import WebSocket, { WebSocketServer } from 'ws';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import express from 'express';
import stopword from 'stopword'

import lda from 'lda';  // Node.js LDA library


const app = express();
const port = 8080;
// set the view engine to ejs
app.set('view engine', 'ejs');

//const compressedData = fs.readFileSync('./compressed.zst');
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('zstd_dictionary'));

const ws = new WebSocket("wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&compress=true");

// total events count
var events = 0;

// total events with hashtags
var tags = 0;

var tweets = [];

// Preprocess tweets and generate n-grams (e.g., bigrams)
function generateNGrams(tokens, n = 2) {
    let ngrams = [];
    for (let i = 0; i <= tokens.length - n; i++) {
      ngrams.push(tokens.slice(i, i + n).join(' '));  // Join tokens to form n-grams
    }
    return ngrams;
}

// Clean the tweets by tokenizing, removing stopwords, and generating n-grams
function preprocessTweets(tweets) {
    return tweets.map(tweet => {
        let tokens = tweet.toLowerCase().split(/\s+/);
        tokens = stopword.removeStopwords(tokens);  // Remove stopwords
        return generateNGrams(tokens, 1);  // Generate bigrams (you can change this to 3 for trigrams)
    });
}

// Apply LDA to extract topics
function extractTopics(tweets, numTopics = 3, numWordsPerTopic = 5) {
    const processedTweets = preprocessTweets(tweets);

    // Flatten the list of n-grams and pass to LDA
    const ngrams = processedTweets.flat();

    const topics = lda(ngrams, numTopics, numWordsPerTopic);

    // Display the extracted topics
    topics.forEach((topic, index) => {
        console.log(`Topic ${index + 1}:`);
        console.log(topic);
        console.log();
    });
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

    tweets.push(eventdata.commit.record.text);

    if(tweets.length>10000){
        extractTopics(tweets);
        tweets=[];
    }

});

// Index route
app.get('/', (req, res) => {


    // Output trending n-grams
    let trending = getTrendingNGrams();

    res.send(trending);
    
});


// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});