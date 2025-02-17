import express from 'express';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import ReconnectingWebSocket from 'rws';

import * as helper from './helper.js';
import { post_index_dictionary, post_tier, deleted_post_dids } from "./data.js";

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

var n_posts_received = 0;
var db_insertions = 0;
var db_insertion_misses = 0;
var post_serial_id = 0;
let last_timestamp = 0;
let last_post_processed_time = 0;
const MAX_POSTS = 100;
let update_queue = [];
const N_MAX_BULK_WRITE = 100;
let current_top_posts = [];
let last_update = 0;
let server_start_time = 0;
var n_posts_total = 0;
const LIST_UPDATE_TIME_IN_SECONDS = 10;

// todo

// - important features to do:
// handle deletes of posts: IMPORTANT or spam will get stuck in top trends
// handle deleting old posts with no more events coming in

// handle deletes of likes and reposts
// handle comments and replies
// fix movement direction from sorting

// - nice features to do:
// topic summary
// top hashtag section
// dark mode / auto dark mode
// image thumbnails
// get usernames from did
// friendly usernames?
// avatars?

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
        if(post_id in post_tier){
            post_tier[post_id].engagement_score = -1;
        }

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
            if(eventdata.commit.record.labels && eventdata.commit.record.labels.values.length>0){
           
                if(label_filters.includes(eventdata.commit.record.labels.values[0].val)){
                    post.nsfw = true;
                }else{
                    //console.log("Unrecognized filter");
                    //console.log(eventdata.commit.record.labels);
                }

            }

            // maybe change to push_back:
            /*

            // insert post data into last place in memory before any negative values
            let insert_idx = post_tier.length-1;
            while(insert_idx >= 0 && post_tier[insert_idx].engagement_score <= 0){
                insert_idx--;
            }
            if(insert_idx < 0){
                insert_idx = 0;
            }

            post_tier.splice(insert_idx, 0, {
                uri,
                post_url,
                createdAt: Date.now(),
                postedAt: eventdata.time_us,
                likes: 0,
                reposts: 0,
                engagement_score: 0,
                movement_direction: 0
            });
            */
            post_index_dictionary[uri] = post_tier.length;

            post_tier.push({
                uri,
                did: eventdata.did,
                post_url,
                createdAt: Date.now(),
                postedAt: eventdata.time_us,
                username: undefined,
                likes: 0,
                reposts: 0,
                engagement_score: 0,
                movement_direction: 0
            });

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
        
            post_serial_id++;
            n_posts_received++;
            n_posts_total++;
            
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
            //helper.UpdatePostPosition(post, d_score, idx);

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
            
            //helper.UpdatePostPosition(post, d_score, idx);

            break;

        }

        // more cases here

        // when a user sets a postgate option
        // to restrict who can reply to a post
        case "app.bsky.feed.postgate":{
        }

        default:{

            //console.log("Unrecognized event: " + eventdata.commit.collection);
            break;
        
        }
    }

    return;

};

function DeleteOldPosts(){

    let n_posts_removed = 0;

    // remove all posts from tail of list with score < 0
    while(post_tier[post_tier.length-1].engagement_score < 0){
        
        // save index of post to be deleted
        const i = post_tier.length-1;

        // remove last post from post_tier
        let deleted_post = post_tier.pop();

        // add deleted post did to dictionary
        deleted_post_dids[deleted_post.uri] = 0;

        // remove post index from dictionary
        delete post_index_dictionary[deleted_post.uri];
        
        // remove post from main mongodb collection
        // todo

        // count number removed posts
        n_posts_removed++;

    }
    if(n_posts_removed > 0){
        console.log("Removed " + n_posts_removed + " posts from tier list tail.")
        n_posts_total -= n_posts_removed;
    }

}

// update top tier list
// this function should be called as often as possible
// also remove all items with score < 0 from list tail
async function UpdateTopList(){

    // update all posts engagement score
    post_tier.forEach(post => {
        let idx = post_index_dictionary[post.uri];
        helper.calculatePostEngagementScore(post, idx);
    })
    
    // create new promise to wait for query and sort to complete
    return new Promise(async (resolve, reject) => {

        let last_post_tier = post_tier;

        // sort tier list by engagement score
        post_tier.sort((a,b) => {
            if(a.engagement_score > b.engagement_score){
                return -1;
            }else if(a.engagement_score < b.engagement_score){
                return 1;
            }else{
                return 0;
            }
        });

        // find difference between old index and new index for each post in tier

        // remap entire post index dictionary
        post_tier.map((item, idx) => {
            post_index_dictionary[item.uri] = idx;
        })

        DeleteOldPosts();

        var posts = post_tier.slice(0,MAX_POSTS);
        let post_uris = posts.map( post => { return post.uri } );
        
        // return post data from mongodb
        const post_data_query_results = await post_collection.find(
            {
                _id: { $in: post_uris }
            }
        );
        let post_data = await post_data_query_results.toArray();

        let post_data_lookup = {};
        post_data.map(post => {
            post_data_lookup[post._id] = post;
        })

        // update list of top post items from mongo by order of id in original list
        current_top_posts = post_uris.map(post_uri => post_data_lookup[post_uri]).filter(doc => doc != undefined);

        // get usernames from post DID for top posts
        for(let i = 0; i < MAX_POSTS; i++){
            
            let post = post_tier[i];

            // skip posts which already have username
            if(post.username != undefined){
                continue;
            }

            helper.get_user_handle(post.did).then(
                result => {
                    post_tier[i].username = result;
                }
            ).catch(
                error => {
                    console.log("ERROR: Could not get username: " + error);
                }
            );

        }

        resolve(0);

    });

}

// run async chain to update top tier list forever
function StartUpdateTopList(){

    setTimeout( async () => {
        
        //console.log("Updating top tier list");

        // Keep updating top list forever
        await UpdateTopList().then(result => {
            // setTimeOut
            last_update = Date.now();
            StartUpdateTopList();
        })
    
    }, LIST_UPDATE_TIME_IN_SECONDS * 1000);

}

// init async chain
StartUpdateTopList();

// Serve index route
app.get('/', async (req, res) => {
    
    console.log("Request");

    const start_time = Date.now();
    
    var posts = post_tier.slice(0, 100);

    const res_time = Date.now() - start_time;


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