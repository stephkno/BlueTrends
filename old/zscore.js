import WebSocket, { WebSocketServer } from 'ws';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import express from 'express';

const app = express();
const port = 8080;

// set the view engine to ejs
app.set('view engine', 'ejs');

//const compressedData = fs.readFileSync('./compressed.zst');
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('zstd_dictionary'));

const ws = new WebSocket("wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.post&compress=true");
const label_filters = ['porn', 'sexual', 'graphic-media', 'nudity']

// variables
const UPDATE_INTERVAL_MINUTES = 10;
// 150 intervals of 10 minutes = 1500 minutes = 25 hours
const HISTORICAL_DATA_CUTOFF = 150;
var last_update = "Never"

var hashtags = {};
var zscores = [];

var events = 0;
var n_hashtags = 0;

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

// calculate a zscore for current value with array of historical values
function calculate_z_score(observation, historical){

    const n = historical.length;
    if(n<2){
        return 0;
    }

    // calculate avg
    const sum = historical.reduce((partialSum, a) => partialSum + a, 0);
    const avg = sum / n;
    
    // calculate std
    const squared_diff = historical.map((x) => ( x - avg ) ** 2 )
    const squared_sum = squared_diff.reduce((partialSum, a) => partialSum + a, 0) / n;
    const std_deviation = Math.sqrt(squared_sum)

    if(std_deviation == 0){
        console.log("std deviation = 0, undefined results")
        return 0;
    }
    // calculate z-score
    return ( observation - avg ) / std_deviation;

}

// update all hashtag historical value arrays
setInterval(() => {

    console.log(`Updating Historical Values...`)

    // count number of hashtags
    var n = 0;

    zscores = [];

    // for all hashtags
    for(var [key, value] of Object.entries(hashtags)){

        zscores.push(
            {
                hashtag: key,
                zscore: calculate_z_score(value[0], value.slice(1))
            }
        )
        
        // insert leading zero into historical data
        value.splice(0,0,0)

        // remove all data after 150 intervals
        value.splice(HISTORICAL_DATA_CUTOFF, 1)

        n++;
    };

    console.log(`Updated ${n} Hashtags`);
    last_update = new Date().toISOString().slice(0,10);

// Execute every 10 minutes
}, 60 * UPDATE_INTERVAL_MINUTES * 1000 );

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
            return
        }
        
        console.log("Unrecognized label: " + eventdata.commit.record.labels)

    }

    const text = eventdata.commit.record.text;
    const new_hashtags = extractHashtags(text);

    new_hashtags.forEach(function(hashtag) {

        if (!hashtags[hashtag]) {
            hashtags[hashtag] = [0];
            n_hashtags += 1
        }

        hashtags[hashtag][0] += 1

    })

    events++;

});

// Index route
app.get('/', (req, res) => {

    const sorted_zscores = zscores.sort((a,b) => b.zscore - a.zscore);
    res.render("pages/zscores",
        {
            sorted_zscores: sorted_zscores,
            events: events,
            n_hashtags: n_hashtags,
            last_update: last_update
        }
    );
    
});
// Index route
app.get('/debug', (req, res) => {

    var list = Object.entries(hashtags);
    list = list.sort((a,b) => b[1][0] - a[1][0]);
    res.send(list);
    
});


// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});