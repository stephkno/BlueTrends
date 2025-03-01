import express from 'express';
import * as zstd from 'zstd-napi';
import * as fs from 'fs';
import ReconnectingWebSocket from 'rws';

import * as helper from './helper.js';
import { post_index_dictionary, post_tier, deleted_post_dids, hashtag_index_dictionary, hashtag_tier, deleted_hashtags } from "./data.js";

const app = express();
const port = 8080;

// set the view engine to ejs
app.set('view engine', 'ejs');

// create connection to jetstream
const dec = new zstd.Decompressor();
dec.setParameters({windowLogMax: 24});
dec.loadDictionary(fs.readFileSync('./data/zstd_dictionary'));

//const ws = new ReconnectingWebSocket.ReconnectingWebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?wantedCollections=app.bsky.feed.*&compress=true`, {});
const ws = new ReconnectingWebSocket.ReconnectingWebSocket(`wss://jetstream1.us-west.bsky.network/subscribe?compress=true`, {});

const label_filters = ['Adult', 'porn', 'sexual', 'graphic-media', 'nudity', 'Nsfw', 'nsfw']

await helper.init_db();
const db = helper.get_db();
const post_collection = db.collection("posts");

var n_posts_received = 0;
var db_insertions = 0;
var db_insertion_misses = 0;
var post_serial_id = 0;
const MAX_POSTS = 100;
let current_top_posts = [];
let last_update = 0;
let server_start_time = 0;
var n_posts_total = 0;
const LIST_UPDATE_TIME_IN_SECONDS = 10;

// - todo:
// handle marking posts that quote nsfw posts

// combine post tier and post data into one item for requests
// put hashtags into db with post URIs
// fetch hashtag URIs from mongodb
// page that returns posts with clicked hasthag in it

// fix movement direction from sorting

// handle deletes of likes comments and reposts?
// handle quotes
// handle displaying 'records' aka quoted posts 
// hotlinking media?

// - nice features to do:
// topics
// hashtags
// dark mode / auto dark mode
// avatars?
// fix mobile ui

function HandlePost(eventdata){

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

    const size = Buffer.byteLength(JSON.stringify(eventdata))

    var post = eventdata.commit.record;

    // remove mysterious empty key item from post json
    delete post[''];

    post._id = uri;
    post.did = eventdata.did;
    post.postedAt = eventdata.time_us;
    post.post_url = post_url;
    post.deleted = false;
    post.nsfw = false;

    post.labels = (eventdata.commit.record.labels &&
         eventdata.commit.record.labels.length>0) 
         ? eventdata.commit.record.labels.values.map(value => { return value.val }) 
         : [];

    post.labels.forEach(label =>{

        // check if filter list contains first label value
        if(label_filters.includes(label)){
            post.nsfw = true;
        }else{
            //console.log("Unrecognized filter");
            //console.log(eventdata.commit.record.labels);
        }

    })
    
    // check if post is a comment
    let is_comment = false;
    if(eventdata.commit && eventdata.commit.record && eventdata.commit.record.reply){
        // get uri of post this is a comment to
        let reply_original_post_uri = eventdata.commit.record.reply.parent.uri;

        // get post and update comment count
        if(reply_original_post_uri in post_index_dictionary){
            post_tier[post_index_dictionary[reply_original_post_uri]].comments++;
        }
        // mark post as comment
        is_comment = true;
    }

    // get quoted post content if available
    let quote = undefined;
    if(post.embed && post.embed.$type == "app.bsky.embed.record" && post.embed.record && post.embed.record.uri){
        quote = post.embed.record.uri;
    }
    
    post_index_dictionary[uri] = post_tier.length;

    post_tier.push({
        uri,
        did: eventdata.did,
        post_url,
        createdAt: Date.now(),
        postedAt: eventdata.time_us,
        author: undefined,
        likes: 0,
        reposts: 0,
        comments: 0,
        quote,
        is_comment,
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
    
    // ignore all nsfw hashtags for now
    if(post.nsfw){
        return;
    }

    let hashtags = eventdata.commit.record.text.split(" ");
    hashtags = hashtags.filter(item => item[0] == "#" && item.length > 1);

    // remove any extraneous words after hashtag
    hashtags = hashtags.map(hashtag => {
        return hashtag.split(" ")[0];
    })
    // remove any extraneous words after hashtag
    hashtags = hashtags.map(hashtag => {
        return hashtag.split("\n")[0];
    })

    hashtags.forEach(hashtag => {
        if(!(hashtag in hashtag_index_dictionary)){
            
            hashtag_index_dictionary[hashtag] = hashtag_tier.length;
            hashtag_tier.push(
                {
                    text:hashtag,
                    count:1,
                    engagement_score: 0,
                    time_last_seen: Date.now(),
                    uri_list: [uri]
                });

        }else{

            hashtag_tier[hashtag_index_dictionary[hashtag]].count++;
            hashtag_tier[hashtag_index_dictionary[hashtag]].time_last_seen = Date.now();
            hashtag_tier[hashtag_index_dictionary[hashtag]].uri_list.push(uri);
        
        }
    });
    
}
function HandleLike(eventdata){
 
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

}
function HandleRepost(eventdata){
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
    
}

function UpdatePost(eventdata){

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

    const size = Buffer.byteLength(JSON.stringify(eventdata))

    var post = eventdata.commit.record;

    // remove mysterious empty key item from post json
    delete post[''];

    post.labels = eventdata.commit.record.labels ? eventdata.commit.record.labels.values.map(value => { return value.val }) : [];

    // check if post update contains labels
    post.labels.forEach(label =>{

        // check if filter list contains first label value
        if(label_filters.includes(label)){
            post.nsfw = true;
        }else{
            //console.log("Unrecognized filter");
            //console.log(eventdata.commit.record.labels);
        }

    })
    
    // skip if post does not exist yet
    if(!(uri in post_index_dictionary)){
        return;
    }

    // get post index
    const idx = post_index_dictionary[uri];

    // update post with new label
    console.log("Updating post!");
    console.log(uri);
    console.log(idx);
    console.log(post_tier[idx]);
    post_tier[idx].nsfw = post.nsfw;
    
}

function DeleteOldPosts(){

    let n_posts_removed = 0;
    let n_hashtags_removed = 0;

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


    // remove all posts from tail of list with score < 0
    while(hashtag_tier[hashtag_tier.length-1].engagement_score < 0){
        
        // save index of post to be deleted
        const i = hashtag_tier.length-1;

        // remove last post from post_tier
        let deleted_hashtag_idx = hashtag_tier.pop();

        // add deleted tag's post did to dictionary
        deleted_hashtags[deleted_hashtag_idx] = 0;

        // remove post index from dictionary
        delete hashtag_index_dictionary[deleted_hashtag_idx];
        
        // remove post from main mongodb collection
        // todo

        // count number removed posts
        n_hashtags_removed++;

    }
    if(n_hashtags_removed > 0){
        console.log("Removed " + n_hashtags_removed + " hashtags from tier list tail.")
        n_posts_total -= n_hashtags_removed;
    }
    
}

// update top tier list
async function UpdateTopList(){

    // create new promise to wait for query and sort to complete
    return new Promise(async (resolve, reject) => {

        // update all posts engagement score
        post_tier.forEach(post => {
            let idx = post_index_dictionary[post.uri];
            helper.calculatePostEngagementScore(post, idx);
        })

        // update all posts engagement score
        hashtag_tier.forEach(hashtag => {
            let idx = hashtag_index_dictionary[hashtag.text];
            helper.calculateHashtagEngagementScore(hashtag, idx);
        })
        
        //let last_post_tier = post_tier;

        // sort tier list by engagement score
        post_tier.sort((a,b) => {
            if(a.engagement_score > b.engagement_score){
                return -1;
            }else if(a.engagement_score < b.engagement_score){
                return 1;
            }
            return 0;
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
        
        // put post_data list in order of query array of IDs
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
            if(post.author != undefined){
                continue;
            }

            helper.get_user_handle(post.did).then(
                result => {
                    post_tier[i].author = result;
                }
            ).catch(
                error => {
                    console.log("ERROR: Could not get username: " + error);
                }
            );

        }

        // sort hashtags

        // sort hashtag list by engagement score
        hashtag_tier.sort((a,b) => {
            if(a.engagement_score > b.engagement_score){
                return -1;
            }else if(a.engagement_score < b.engagement_score){
                return 1;
            }else{
                return 0;
            }
        });

        // remap entire post index dictionary
        hashtag_tier.map((hashtag, idx) => {
            hashtag_index_dictionary[hashtag.text] = idx;
        })

        resolve(0);

    });

}

// on jetstream receive message event
ws.onmessage = async function(event){

    const eventdata = JSON.parse(event.data);
    
    if(eventdata.kind != "commit"){
        return;
    }

        // looking for any kind of update label event for nsfw content
    if(eventdata.commit.operation=="update" && eventdata.commit.collection == "app.bsky.feed.post"){
        UpdatePost(eventdata);
    }

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

            HandlePost(eventdata);
            break;

        }

        // when a user likes a thread
        case "app.bsky.feed.like":{

            HandleLike(eventdata);
            break;

        }

        // when a user reposts a thread
        case "app.bsky.feed.repost":{
            
            HandleRepost(eventdata);
            break;

        }

        // more cases here

        // when a user sets a postgate option
        // to restrict who can reply to a post
        case "app.bsky.feed.postgate":{
            /*            
            console.log("postgate");
            console.log(eventdata);
            const post_url = "https://bsky.app/profile/" + eventdata.did + "/post/" + eventdata.commit.rkey;
            console.log(post_url);
            */
            // https://atproto.blue/en/latest/atproto/atproto_client.models.app.bsky.feed.postgate.html
            break;
        }
        case "app.bsky.feed.threadgate":{
            /*
            console.log("threadgate");
            console.log(eventdata);
            console.log("allow:" + JSON.stringify(eventdata.commit.record.allow));
            const post_url = "https://bsky.app/profile/" + eventdata.did + "/post/" + eventdata.commit.rkey;
            console.log(post_url);
            */
            // [] = no replies allowed
            // https://atproto.blue/en/latest/atproto/atproto_client.models.app.bsky.feed.threadgate.html
            break
        }
        default:{
            //console.log("Other event: " + eventdata.commit.collection);
            break;
        }
    }

    return;

};

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
    
    console.log("Num posts: " + post_tier.length);
    
    const top_posts = post_tier.slice(0, 100);
    
    console.log(top_posts.length);
    console.log(current_top_posts.length);
    
    let ctp = current_top_posts.map( (post, i) => {
        post.comments = top_posts[i].comments;
        post.reposts = top_posts[i].reposts;
        post.likes = top_posts[i].likes;
        post.author = top_posts[i].author;
        post.engagement_score = top_posts[i].engagement_score;
        return post;
    });
    
    console.log("Num hashtags: " + hashtag_tier.length);

    const top_hashtags = hashtag_tier.slice(0,100);

    const res_time = Date.now() - start_time;

    console.log("Responding");

    res.render("pages/index",
        {
            posts: ctp,
            top_hashtags,
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

    console.log("Done");

});

// Serve index route
app.get('/hashtag', async (req, res) => {
    
    console.log("Hashtag page Request");
    const start_time = Date.now();

    const ht_query = "#" + req.query.t;

    // check if hashtag is in dictionary (exists)
    if(!(ht_query in hashtag_index_dictionary)){
        res.send(`Error: Hashtag ${ht_query} not found!`);
        return;
    }

    // get index of hashtag from dictionary
    const ht_index = hashtag_index_dictionary[ht_query];
    console.log(ht_index);

    // get get hashtag post uri's from hashtag tierlist
    let hashtag_uris = hashtag_tier[ht_index].uri_list;

    hashtag_uris = hashtag_uris.filter(hashtag => {
        return !(hashtag in deleted_post_dids)
    } )

    console.log(hashtag_uris);
    
    // return post data from mongodb by uri
    const post_data_query_results = await post_collection.find(
        {
            _id: { $in: hashtag_uris }
        }
    );
    let posts = await post_data_query_results.toArray();

    // sort posts by uri's in hashtag list
    let post_data_lookup = {};
    posts.map(post => {
        post_data_lookup[post._id] = post;
    })
    posts = hashtag_uris.map(hashtag_uri => post_data_lookup[hashtag_uri]).filter(doc => doc != undefined);

    // get top hashtags
    const top_hashtags = hashtag_tier.slice(0,100);

    const res_time = Date.now() - start_time;

    console.log("Responding");

    res.render("pages/hashtag",
        {
            ht_query,
            posts,
            top_hashtags,
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

    console.log("Done");

});


// try to close db cleanly on exit
function cleanup(){
    helper.close_db();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

server_start_time = Date.now();

const real_port = process.env.PORT || port;
// Start the express server
app.listen(real_port, () => {
    console.log(`Server is running on http://localhost:${real_port}`);
});