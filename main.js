import express from 'express';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import ReconnectingWebSocket from 'rws';

import * as helper from './helper.js';
import { post_index_dictionary, post_tier } from "./data.js";

import { ObjectId } from 'mongodb';

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
var n_posts_received = 0;
var n_posts_total = 0;
var db_insertions = 0;
var db_insertion_misses = 0;
var post_serial_id = 0;
let last_timestamp = 0;
let last_post_processed_time = 0;
const items_per_page = 42;
let update_queue = [];
const N_MAX_BULK_WRITE = 100;
let current_top_posts = [];
let last_update = 0;
let server_start_time = 0;
let deleted_post_dids = {};

// todo list
// fix mongodb insert error

// get usernames from did
// handle deletes of likes and reposts

// handle comments and replies
// remove low rated posts
// - that have negative engagement score?
// - that are too old?

// topic summary
// hashtag section
// nsfw hide switch
// dark mode
// auto dark mode
// image thumbnails
// links / link previews?
// avatars?
// friendly usernames?

// bulkwrite process lock
let BulkWriteInProcess = false;

// process bulkwrite for last 100 items in buffer
// occasionally getting error
// Bulkwrite error: MongoBulkWriteError: An empty update path is not valid.
// not sure how that will impact app in future
async function ProcessBulkWrite(){

    // lock from other events if bulkwrite in process
    if(BulkWriteInProcess){
        return;
    }

    // update if queue is long enough
    if(update_queue.length >= N_MAX_BULK_WRITE){
        //console.log("Begin bulk write DB " + update_queue.length);
        //console.log("BulkWrite");

        // lock function
        BulkWriteInProcess = true;

        // get top 100 items from buffer
        let updates = update_queue.splice(0,N_MAX_BULK_WRITE);

        if(updates.length == 0){
            console.log("Bulkwrite error: Empty Bulkwrite buffer");
            BulkWriteInProcess = false;
            return;
        }

        updates.forEach(item => {
            if(item.uri == ""){
                console.log("Bulkwrite error: Empty URI");
            }
        })

        // write them to mongodb
        await post_collection.bulkWrite(updates).then(result => {

            // count successful insertions
            db_insertions += result.upsertedCount;

            // unlock
            BulkWriteInProcess = false;

        }).catch(async err => {

            console.log("Bulkwrite error: " + err);
            console.log("Attempting single inserts");
            console.log("N_updates: " + updates.length);

            var single_inserts = 0;

            // attempt to insert single items
            await Promise.all(updates.map(async update => {
                await post_collection.insertOne(update).then(res => {
                    
                    db_insertions++;
                    single_inserts++;

                }).catch(err => {
                    
                    db_insertion_misses ++;
                    console.log("Bulkwrite error: Error writing single item: " + err);
                    console.log(update);

                })
            }));

            console.log("Inserted " + single_inserts + " items individually");
            BulkWriteInProcess = false;
        
        });
        
        
    }
}

// on jetstream receive message event
ws.onmessage = async function(event){

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

            // remove mysterious empty key item from post json
            delete post[''];

            post._id = uri;
            post.did = eventdata.did;
            post.timestamp = eventdata.time_us;
            post.post_url = post_url;
            post.deleted = false;
            post.author = "[Pending...]";
            post.nsfw = false;


            // attempt to label nsfw posts
            if(eventdata.commit.record.labels &&eventdata.commit.record.labels.values.length>0){
           
                if(label_filters.includes(eventdata.commit.record.labels.values[0].val)){
                    post.nsfw = true;
                }else{
                    //console.log("Unrecognized filter");
                    //console.log(eventdata.commit.record.labels);
                }

            }
            
            if(uri == ""){
                console.log("Attempted to push an empty uri string");
            }else{

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
                    movement_direction: 0
                });

                // insert post data into mongodb collection
                /*
                update_queue.push({
                    updateOne: {
                        filter: { _id: uri },
                        update: { $setOnInsert: post },
                        upsert: true 
                    }
                });
                */

                post_collection.updateOne(
                    { _id: uri },
                    { $set: post },
                    { upsert: true}
                ).then(res => {
                    
                    db_insertions++;

                }).catch(res => {
                    console.log("Err: " + res);
                    console.log(uri);
                    console.log(post);
                });
            
            }
            
            post_serial_id++;
            n_posts_received++;
            n_posts_total++;
            
            //ProcessBulkWrite();
            
            break;

        }

        // when a user likes a thread
        case "app.bsky.feed.like":{

            const uri = eventdata.commit.record.subject.uri;

            // get post index from dictionary
            // prevent processing old posts that have been removed
            if(!(uri in post_index_dictionary) || (uri in deleted_post_dids)){
                return;
            }

            // get post index from dictionary
            const idx = post_index_dictionary[uri];
            
            // increment like count for post
            let post = post_tier[idx];
            post.likes++;
            
            // update engagement score for post using calculateEngagentScore func
            const d_score = helper.calculatePostEngagementScore(post, idx);
            
            // find new position for post in tier array
            helper.UpdatePostPosition(post, d_score, idx);

            break;
        }

        // when a user reposts a thread
        case "app.bsky.feed.repost":{
            const uri = eventdata.commit.record.subject.uri;

            // get post index from dictionary
            if(!(uri in post_index_dictionary) || (uri in deleted_post_dids)){
                return;
            }
            
            // get post index from dictionary
            const idx = post_index_dictionary[uri];

            // increment repost count for post
            let post = post_tier[idx];
            post.reposts++;
            
            // update engagement score for post using calculateEngagentScore func
            const d_score = helper.calculatePostEngagementScore(post, idx);
            
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

            //console.log("Unrecognized event: " + eventdata.commit.collection);
            break;
        
        }
    }

    return;

};

// update top tier list
// this function should be called as often as possible
// also remove all items with score < 0 from list tail
async function UpdateTopList(){

    // save current top list for archive
    console.log("Updating tier list...");
    
    // create new promise to wait for query and sort to complete
    return new Promise(async (resolve, reject) => {

        let n_posts_removed = 0;

        // remove all posts from tail of list with score < 0
        while(post_tier[post_tier.length-1].engagement_score < 0){
            
            console.log("Delete post");
            // save index of post to be deleted
            const i = post_tier.length-1;

            // remove last post from post_tier
            let deleted_post = post_tier.pop();

            // add deleted post did to dictionary
            deleted_post_dids[deleted_post._id] = 0;

            // remove post index from dictionary
            delete post_index_dictionary[i];
            
            // remove post from main mongodb collection
            // todo

            // count number removed posts
            n_posts_removed++;

        }
        if(n_posts_removed > 0){

            console.log("Removed " + n_posts_removed + " posts from tier list tail.")
            n_posts_total -= n_posts_removed;
        
        }
        
        // decrease total post count
        
        //console.log("Begin Update of Top List");
        //console.log("Slicing top posts");

        // return top 25 posts from post_tier list
        //if(req.query.reverse){
        //    var posts = post_tier.slice(post_tier.length-items_per_page,post_tier.length);
        //}else{
        var posts = post_tier.slice(0,items_per_page);
        //}

        //console.log("Mapping post uris");
        let post_uris = posts.map( post => { return post.uri } );
        
        //console.log("Querying db");

        // return post data from mongodb
        const post_data_query_results = await post_collection.find(
            {
                _id: { $in: post_uris }
            }
        );
        let post_data = await post_data_query_results.toArray();
    //    const post_query_explain = await post_data_query_results.explain();

        //console.log("Sorting results db");

        // Sort resulting items from mongodb query

        // create dictionary of post with id as key

        let post_data_lookup = {};
        post_data.map(post => {
            post_data_lookup[post._id] = post;
        })

        // update list of top post items from mongo by order of id in original list
        current_top_posts = post_uris.map(post_uri => post_data_lookup[post_uri]).filter(doc => doc != undefined);

        //console.log(current_top_posts);

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

        console.log("Done updating tier list...");
        resolve(0);

    });

}

// run async chain to update top tier list forever
function StartUpdateTopList(){

    setTimeout( () => {
        
        //console.log("Updating top tier list");

        // Keep updating top list forever
        UpdateTopList().then(result => {
            // setTimeOut
            last_update = Date.now();
            StartUpdateTopList();
        })
    
    }, 10000);

}

// init async chain
StartUpdateTopList();

// Serve index route
app.get('/', async (req, res) => {

    console.log("Request");
    const start_time = Date.now();
    
    console.log("Returning " + current_top_posts.length + " posts");

    var posts = post_tier.slice(0, items_per_page);

    const res_time = Date.now() - start_time;

    console.log("Done");

    res.render("pages/index",
        {
            posts,
            post_data: current_top_posts,
            n_posts_received,
            n_posts_total,
            db_insertions,
            db_insertion_misses,
            last_update,
            now: Date.now(),
            res_time,
            server_start_time
        }
    );

});

// try to close db cleanly on exit
function cleanup(){
    helper.close_db();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server_start_time = Date.now();

// Start the express server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});