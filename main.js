import express from 'express';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import ReconnectingWebSocket from 'rws';

import * as helper from './helper.js';
import { post_index_dictionary, post_tier } from "./data.js";

const app = express();
const port = 8080;

// set the view engine to ejs
app.set('view engine', 'ejs');

// create connection to jetstream
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('./data/zstd_dictionary'));

//const ws = new WebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?cursor=${helper.get_midnight_timestamp()}&?wantedCollections=app.bsky.feed.*&compress=true`);
const ws = new ReconnectingWebSocket.ReconnectingWebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.*&compress=true`, {});

const label_filters = ['Adult', 'porn', 'sexual', 'graphic-media', 'nudity', 'Nsfw', 'nsfw']

await helper.init_db();
const db = helper.get_db();
const post_collection = db.collection("posts");

// events counter
var n_events = 0;
var post_serial_id = 0;
let last_timestamp = 0;
let last_post_processed_time = 0;

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

        // handle post/like/comment deletes
        return;
    }

    switch(eventdata.commit.collection){
        // when a user creates a new thread
        case "app.bsky.feed.post":{
            

            const uri = 
            "at://" 
            + eventdata.did
            + "/" 
            + eventdata.commit.collection 
            + "/"
            + eventdata.commit.rkey;

            const post_url = "https://bsky.app/profile/" + eventdata.did + "/post/" + eventdata.commit.rkey;

            // bsky url format:
            // http://www.bsky.app/<DID>/commit/<RKEY>
            last_post_processed_time = eventdata.commit.createdAt;
            last_timestamp = eventdata.time_us;

            const size = Buffer.byteLength(JSON.stringify(eventdata))

            var post = eventdata.commit.record;
            post._id = uri;
            post.did = eventdata.did;
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
            
            // insert post index in tier list
            post_index_dictionary[uri] = post_tier.length;
            
            // insert post data into last place in memory
            post_tier.push({
                uri,
                post_url,
                createdAt: Date.now(),
                postedAt: eventdata.time_us,
                likes: 0,
                reposts: 0,
                engagement_score: 0,
                d_score: 0
            });
            
            // insert post data into mongodb collection
            post_collection.updateOne(
                { _id: uri },
                { $setOnInsert: post },
                { upsert: true }
              ).then(result => {
                if (result.upsertedCount === 1) {
                  //console.log("Inserted document with _id: " + uri);
                } else {
                  console.log("Duplicate key: " + uri);
                }
              }).catch(err => {
                console.log(err);
              });
            

            post_serial_id++;
            n_events++;
            break;

        }

        // when a user likes a thread
        case "app.bsky.feed.like":{

            const uri = eventdata.commit.record.subject.uri;

            // get post index from dictionary
            if(!(uri in post_index_dictionary)){
                return;
            }

            // get post index from dictionary
            const idx = post_index_dictionary[uri];
            
            // increment like count for post
            let post = post_tier[idx];
            post.likes++;
            
            // update engagement score for post using calculateEngagentScore func
            const d_score = helper.calculatePostEngagementScore(post);
            
            // find new position for post in tier array
            helper.UpdatePostPosition(post, d_score, idx);

            break;
        }

        // when a user reposts a thread
        case "app.bsky.feed.repost":{
            const uri = eventdata.commit.record.subject.uri;

            // get post index from dictionary
            if(!(uri in post_index_dictionary)){
                return;
            }
            
            // get post index from dictionary
            const idx = post_index_dictionary[uri];

            // increment repost count for post
            let post = post_tier[idx];
            post.reposts++;
            
            // update engagement score for post using calculateEngagentScore func
            const d_score = helper.calculatePostEngagementScore(post);
            
            helper.UpdatePostPosition(post, d_score, idx);

            break;

        }
        
        // more cases here

        // when a user sets a postgate option
        // to restrict who can reply to a post
        case "app.bsky.feed.postgate":{
            // what does this do?            
        }

        default:{
            console.log("Unrecognized event: " + eventdata.commit.collection);
            break;
        }
    }
    
    return;

};

// Index route
app.get('/', async (req, res) => {

    console.log("Request");
    const start_time = Date.now();

    // return top 25 posts from post_tier list
    if(req.query.reverse){
        var posts = post_tier.slice(post_tier.length-42,post_tier.length);
    }else{
        var posts = post_tier.slice(0,42);
    }
    
    let post_uris = posts.map( post => { return post.uri } );
    
    // return post data from mongodb
    // aggregate results by id in list
    // return items from collection in order of ids
    const post_data = await post_collection.aggregate([
        // match ids from list
        { $match: { _id: { $in: post_uris } } },
        // add field to results for id's index in array
        { $addFields: { sortOrder: { $indexOfArray: [post_uris, "$_id"] } } },
        // set result sort order to descending
        { $sort: { sortOrder: 1 } },
        // removes the order field from the documents (??)
        { $project: { sortOrder: 0 } }
      ]).toArray();


    // get author username from bsky api
    // for each item which has null authorname fetch author name by did
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
    console.log("Done");

    res.render("pages/index",
        {
            posts: posts,
            post_data: post_data,
            n_events,
            res_time: res_time,
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
