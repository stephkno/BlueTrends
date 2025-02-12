import axios from 'axios';
import mongo from 'mongodb';

import { post_index_dictionary, post_tier } from "./data.js";

export {
    get_current_timestamp,
    get_current_datetime,
    get_midnight_timestamp,
    get_user_handle,
    init_db,
    get_db,
    close_db,
    calculatePostEngagementScore,
    UpdatePostPosition
};

function calculatePostEngagementScore(post, idx) {

    // don't handle post which has already been marked for removal
    if(post.engagement_score < 0){
        return -1;
    }

    const MAX_POST_POSITION = 1000;
    const MAX_POST_AGE = 60; // 5 hours

    const likesWeight = 1;
    const repostsWeight = 1;
    //const commentsWeight = 3;
    const timeDecayFactor = 0.9; // Adjust this factor based on how quickly you want scores to decay

    // calculate engagement score
    const timeSincePost = (Date.now() - new Date(post.createdAt).getTime()) / 1000; // Time in seconds
    const timeDecay = Math.exp(-timeDecayFactor * timeSincePost / 3600); // Decay over hours
    const weightedLikes = post.likes * likesWeight;
    const weightedReposts = post.reposts * repostsWeight;

    let score = 0;
    let d_score = 0;

    if( timeSincePost > MAX_POST_AGE && idx > MAX_POST_POSITION ){
        
        // mark post for removal
        // should cause post to sink to bottom of tier list
        score = -1;

    }else{
        score = (weightedLikes
            + weightedReposts
            //+ post.comments * commentsWeight)
        ) * timeDecay;
    
    }

    // get change in post score
    d_score = score - post.engagement_score;
    post.engagement_score = score;

    // if post is older than 5 hours maybe change its engagement score to -1
    // then scan all posts from end of list backwards and delete all with score < 0

    return d_score;
}

// update position of post in tierlist based on its new engagement score
function UpdatePostPosition(post, d_score, idx){

    // update engagement score for post using calculateEngagentScore func
    // if score increased move up list
    if(d_score > 0){

        let new_idx = idx-1;

        // move up list until new place is found
        while(new_idx >= 0 && post.engagement_score > post_tier[new_idx].engagement_score){

            // swap posts
            // new_idx+1 moving up
            // new_idx moving down
            let tmp = post_tier[new_idx+1];
            post_tier[new_idx+1] = post_tier[new_idx];
            post_tier[new_idx] = tmp;

            // update index in post index dictionary
            post_index_dictionary[post.uri] = new_idx;
            post_index_dictionary[post_tier[new_idx+1].uri] = new_idx+1;

            post_tier[new_idx+1].movement_direction = -1;
            post_tier[new_idx].movement_direction = 1;

            // don't decrement index if we found place at 0
            if(new_idx != 0){
                new_idx--;
            }
        }

    }
    // score decreased, move down list
    else{

        let new_idx = idx+1;

        // move up list until new place is found
        while(post.engagement_score < post_tier[new_idx].engagement_score && new_idx < post_tier.length-1){
        
            // swap posts
            let tmp = post_tier[new_idx-1];
            post_tier[new_idx-1] = post_tier[new_idx];
            post_tier[new_idx] = tmp;

            // update index in post index dictionary
            post_index_dictionary[post.uri] = new_idx;
            post_index_dictionary[post_tier[new_idx-1].uri] = new_idx-1;

            post_tier[new_idx-1].movement_direction = 1;
            post_tier[new_idx].movement_direction = -1;

            if(new_idx != post_tier.length){
                new_idx++;
            }

        }

    }
}

const mongo_uri = "mongodb://localhost:27017?connectTimeoutMS=6000000";
const mongo_client = new mongo.MongoClient(mongo_uri);

async function init_db(){
    await mongo_client.connect();
    await mongo_client.db("bluesky_data").command({"drop":"posts"});
    await mongo_client.db("bluesky_data").createCollection("posts");
    await mongo_client.db("bluesky_data").collection("posts").createIndex({ _id:1 })
    //console.log(await mongo_client.db("bluesky_data").collection("posts").indexes());
}

async function close_db(){
    await mongo_client.close()
}

function get_db(){
    return mongo_client.db("bluesky_data");
}

const get_current_timestamp = () => {
    const now = Date.now();
    const hrTime = process.hrtime();
    const milliseconds = Math.floor(now);
    const microseconds = Math.floor(hrTime[1] / 1000);
    return milliseconds * 1000 + microseconds % 1000;
};

function get_current_datetime(){
    return Date.now();
}

const get_midnight_timestamp = () => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.getTime();
};

async function get_user_handle(did){
    
    const req_addr = `https://plc.directory/${did}`
    const res = await axios.get(req_addr);
    return res.data.alsoKnownAs[0].slice(5);

}
