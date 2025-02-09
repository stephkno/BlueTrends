import * as zstd from 'zstd-napi';

import * as fs from 'fs';
import express from 'express';

import * as helper from './helper.js';
import * as minheap from './minheap.js';

import WebSocket, { WebSocketServer } from 'ws';
import ReconnectingWebSocket from 'rws';

const app = express();
const port = 8080;

// set the view engine to ejs
app.set('view engine', 'ejs');

// total events count
var events = 0;
var last_timestamp = 0;

// storage
var last_post_processed_time = 0;
var post_serial_id = 0;

var post_dictionary = {}
var postInsertBuffer = []
var postUpdateBuffer = []
const maxPostUpdateBuffer = 1000;

// create connection to jetstream
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('zstd_dictionary'));

//const ws = new WebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?cursor=${helper.get_midnight_timestamp()}&?wantedCollections=app.bsky.feed.*&compress=true`);
const ws = new ReconnectingWebSocket.ReconnectingWebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.*&compress=true`, {});

const label_filters = ['Adult', 'porn', 'sexual', 'graphic-media', 'nudity', 'Nsfw', 'nsfw']

await helper.init_db();

var dids = []

// on jetstream receive message event
ws.onmessage = function(event){

    const eventdata = JSON.parse(event.data);//JSON.parse(dec.decompress(event.data).toString());
    
    if(eventdata.kind == "identity" || eventdata.kind == "account"){
        return;
    }

    if(!eventdata.commit){
        console.log("No commit");
        console.log(eventdata);
        return;
    }

    last_timestamp = eventdata.time_us;

    if(eventdata.commit.operation == "delete"){
        
        const post_id = 
        "at://" 
        + eventdata.did
        + "/"
        + eventdata.commit.collection
        + "/"
        + eventdata.commit.rkey;

        // handle deletes
        /*
        if(eventdata.commit.collection=='app.bsky.feed.post' &&
        posts.hasOwnProperty(post_id)){
            posts[post_id].deleted = true;
        }
        */
        return;
    }

    switch(eventdata.commit.collection){
        
        // when a user creates a new thread
        case "app.bsky.feed.post":{
            
            const post_uri = 
            "at://" 
            + eventdata.did
            + "/" 
            + eventdata.commit.collection 
            + "/"
            + eventdata.commit.rkey;

            const post_url = "https://bsky.app/profile/" + eventdata.did + "/post/" + eventdata.commit.rkey;

            // bsky url format:
            // http://www.bsky.app/<DID>/post/<RKEY>
            last_post_processed_time = eventdata.commit.createdAt;
            last_timestamp = eventdata.time_us;

            const size = Buffer.byteLength(JSON.stringify(eventdata))

            var post = eventdata.commit.record;
            post._id = post_uri;
            post.timestamp = eventdata.time_us;
            post.likes = 0;
            post.reposts = 0;
            post.post_url = post_url;
            post.deleted = false;
            post.author = "[Pending...]";
            post.nsfw = false;

            // attempt to label nsfw posts
            if(eventdata.commit.record.labels &&eventdata.commit.record.labels.values.length>0){
           
                if(label_filters.includes(eventdata.commit.record.labels.values[0].val)){
                    post.nsfw = true;
                }else{
                    console.log("Unrecognized filter");
                    console.log(eventdata.commit.record.labels);
                }

            } 
            
            const db = helper.get_db();
            const collection = db.collection("posts");
            
            // insert post into mongodb
            // prevent duplicate key errors
            if(!dids.includes(post_uri)){
                collection.updateOne(
                    { _id: post_uri },
                    { $setOnInsert: post },
                    { upsert: true }
                  ).then(result => {
                    if (result.upsertedCount === 1) {
                      //console.log("Inserted document with _id: " + post_uri);
                    } else {
                      console.log("Duplicate key: " + post_uri);
                    }
                  }).catch(err => {
                    console.log(err);
                  });
            }else{
                console.log("Duplicate key: " + post_uri)
            }
            dids.push(post_uri);

            if(!post_dictionary[post_uri]){
                post_dictionary[post_uri] = {
                    likes:0,
                    reposts:0,
                    nsfw: post.nsfw,
                    timestamp: eventdata.time_us
                }
            }else{
                // found duplicate post
            }

            post_serial_id++;
            events++;
            break;

        }

        // when a user likes a thread
        case "app.bsky.feed.like":{

            const post_uri = eventdata.commit.record.subject.uri;

            if(post_dictionary[post_uri]){
                post_dictionary[post_uri].likes += 1
            }
            break;
        }

        // when a user reposts a thread
        case "app.bsky.feed.repost":{
            const post_uri = eventdata.commit.record.subject.uri;

            if(post_dictionary[post_uri]){
                post_dictionary[post_uri].reposts += 1
            }
            break;

        }
        
        // more cases here

        // when a user sets a postgate option
        // to restrict who can reply to a post
        case "app.bsky.feed.postgate":{
            //console.log("postgate");
            //console.log(eventdata);
            //console.log(eventdata.commit.record.embeddingRules);
        }   

        default:{
            //console.log("Unrecognized collection: " + eventdata.commit.collection);
            break;
        }
    }
    
    return;

};

// routing
app.get('/time', (req, res) => {
    
    const curr_time = helper.get_current_datetime();
    const out = "last event time: " + last_post_processed_time + '<p>current time: ' + curr_time;
    res.send(out);

});

// Index route
app.get('/', async (req, res) => {

    console.log("Request");
    const start_time = Date.now();

    console.log("Getting items list");

    // get top posts
    var sorted_posts = Object.entries(post_dictionary);

    // too slow!
    //var test_sort = sorted_posts.sort( (a,b) => b[1].likes - a[1].likes);
    //test_sort = test_sort.slice(0,25)

    console.log("Minheap: Finding top 25 items");

    // get top 25 post ids
    sorted_posts = minheap.findTopN(25, sorted_posts);

    console.log("Remapping ids");
    const top_post_ids = sorted_posts.map( (x) => x[0] );
    
    const db = helper.get_db();

    console.log("Finding posts from DB");
    const candidate_posts = await db.collection("posts").aggregate([
        { $match: { _id: { $in: top_post_ids } } },
        { $addFields: { sortOrder: { $indexOfArray: [top_post_ids, "$_id"] } } },
        { $sort: { sortOrder: 1 } },
        { $project: { sortOrder: 0 } }
      ]).toArray();

    console.log("Appending likes and reposts data");
    for(var i = 0; i < candidate_posts.length; i++){
        candidate_posts[i].likes = sorted_posts[i][1].likes;
        candidate_posts[i].reposts = sorted_posts[i][1].reposts;
    }

    // get username from post DID
    /*
    helper.get_user_handle(eventdata.did).then(
        result => {
        }
    ).catch(
        error => {
            console.log(error);
        }
    );
    */
    
    const res_time = Date.now() - start_time;
    const dict_size = Buffer.byteLength(JSON.stringify(post_dictionary))
    console.log("Done");
    
    res.render("pages/index",
        {
            events: events,
            candidate_posts: candidate_posts,
            res_time: res_time,
            dict_size: dict_size
        }
    );

});

function cleanup(){
    helper.close_db();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});