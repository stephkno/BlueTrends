import WebSocket, { WebSocketServer } from 'ws';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import { spawn } from 'child_process';
import express from 'express';
import { removeStopwords, eng } from 'stopword'

/*

const pythonProcess = spawn('python3', ['yake_parse.py'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// receive keywords
pythonProcess.stdout.on('data', (data) => {

    const keywords = data.toString().toLowerCase().split("\n");

    for(var i = 0; i < keywords.length; i++){
        
        const keyword = keywords[i];

        if(keyword==''){
            continue;
        }

        // new word in english word dict
        if(!(keyword in keyword_frequency_dict.en)){
            keyword_frequency_dict.en[keyword] = 1;
            return;
        }
        // increment word count
        keyword_frequency_dict.en[keyword] += 1;
    
    }

});


pythonProcess.on('close', (code) => {
  console.log(`child process exited with code ${code}`);
});

pythonProcess.on('error', (error) => {
  console.error(`error: ${error.message}`);
});
*/

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

// nsfw hashtag blacklist
var blacklist = new Set();

// dict to hold hashtag frequencies
var keyword_frequency_dict = {
    en:{
    }
};

var historical_data = [

]

/*
const intervalId = setInterval(() => {
    hashtag_frequency_dict.en.sort((a, b) => (b.count - a.count));
    console.log(hashtag_frequency_dict.en);
}, 10000); // Execute every 10000 milliseconds (10 seconds)
*/

const time = () => {
    const now = Date.now();
    const hrTime = process.hrtime();
    const milliseconds = Math.floor(now);
    const microseconds = Math.floor(hrTime[1] / 1000);
    return milliseconds * 1000 + microseconds % 1000;
};

var delta_words = {
    en:{}
}

const intervalId = setInterval(() => {

    historical_data.push(keyword_frequency_dict);
    
    keyword_frequency_dict = {
        en:{}
    }

    delta_words = {
        en:{}
    }

    if(historical_data.length > 1){
        const last = historical_data[historical_data.length - 1];
        const snd_last = historical_data[historical_data.length - 2];
        
        Object.keys(last.en).forEach(function(word){
            
            delta_words.en[word] = last.en[word] - snd_last.en[word];
        
        });
    }
    console.log("Update");
    
}, 300000);

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

    // send text to keyword processor
    //pythonProcess.stdin.write(eventdata.commit.record.text);
    
    //const ngrams = get_ngrams(5, eventdata.commit.record.text);
    /*
    console.log(ngrams);

    for(var i = 0; i < ngrams.length; i++){
        
        const key_gram = ngrams[i];

        // new word in english word dict
        if(!(key_gram in keyword_frequency_dict.en)){
            keyword_frequency_dict.en[key_gram] = 1;
            return;
        }
        // increment word count
        keyword_frequency_dict.en[key_gram] += 1;
    
    }
    */

    // parse words in commit

    var text = eventdata.commit.record.text.toLowerCase();
    text = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
    text = text.split(' ');
    const words = removeStopwords(text);
    var len = words.length;

    //const lang = eventdata.commit.record.langs[0];

    // Send input to the Python process
    events++;

    // extract hashtags
    for(var i = 0; i < len; i++){
        
        const word = words[i].toLowerCase();

        // skip empty words
        if(word.length <= 1){
            continue;
        }
        
        // new language in hashtag_frequency_dict
        /*
        if(!(lang in hashtag_frequency_dict)){
            
            hashtag_frequency_dict[lang] = {}
            console.log(lang);

        }
        */

        // new word in english word dict
        if(!(word in keyword_frequency_dict.en)){
            keyword_frequency_dict.en[word] = 1;
            continue;
        }
        // increment word count
        keyword_frequency_dict.en[word] += 1;

    }

});

// Index route
app.get('/hashtags', (req, res) => {

    var words = Object.entries(delta_words.en);

    words = words.filter(function(item){
        return item[1] > 1;
    });

    words.sort(([, A], [, B]) => B - A);

    res.render("pages/index",
        {
            events: events,
            words: words
        }
    ); 
    
});

// Index route
app.get('/', (req, res) => {

    var words = Object.entries(keyword_frequency_dict.en);

    words = words.filter(function(item){
        return item[1] > 1;
    });

    words.sort(([, A], [, B]) => B - A);

    res.render("pages/keywords",
        {
            events: events,
            words: words
        }
    );
    
});

// Blacklist route
app.get('/blacklist', (req, res) => {

    var words = Object.entries(hashtag_frequency_dict.en);

    words = words.filter(function(item){
        return !blacklist.has(item[0]);
    });
    words = words.filter(function(item){
        return item[1] > 1;
    });

    words.sort(([, A], [, B]) => B - A);

    const bannedwords = Array.from(blacklist);

    res.render("pages/blacklist",
        {
            events: events,
            words: words,
            bannedwords: bannedwords
        }
    );
    
});
 
app.get('/banword', (req, res) => {
    blacklist.add(req.query.word);
    console.log(blacklist);
    res.send(req.query.word + " added to list");
});

app.get('/unbanword', (req, res) => {
    blacklist.delete(req.query.word);
    res.send(req.query.word + " removed from list");
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});