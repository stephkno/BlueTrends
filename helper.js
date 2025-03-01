import axios from 'axios';
import mongo from 'mongodb';

import { post_index_dictionary, post_tier, deleted_post_dids } from "./data.js";
const MONGO_ADDRESS = "";

export {
    get_current_timestamp,
    get_current_datetime,
    get_midnight_timestamp,
    get_user_handle,
    init_db,
    get_db,
    close_db,
    calculatePostEngagementScore,
    calculateHashtagEngagementScore
};

function calculatePostEngagementScore(post, idx) {

    // don't handle post which has already been marked for removal
    if(post.engagement_score < 0){
        return -1;
    }

    const MAX_POST_POSITION = 1000;
    const MAX_POST_AGE = 1 * 60 * 60;// 1 hours

    const likesWeight = 1;
    const repostsWeight = 1;
    const commentsWeight = 1;
    const timeDecayFactor = 0.9; // Adjust this factor based on how quickly you want scores to decay

    // calculate engagement score
    const timeSincePost = (Date.now() - new Date(post.createdAt).getTime()) / 1000; // Time in seconds
    const timeDecay = Math.exp(-timeDecayFactor * timeSincePost / 3600); // Decay over hours
    const weightedLikes = post.likes * likesWeight;
    const weightedReposts = post.reposts * repostsWeight;
    const weightedComments = post.comments * commentsWeight;

    let score = 0;
    let d_score = 0;

    // mark to remove all posts older than 1 hour and below tier position 1000
    if( timeSincePost > MAX_POST_AGE && idx > MAX_POST_POSITION ){
        
        // mark post for removal
        // should cause post to sink to bottom of tier list
        score = -1;

    }else{
        
        score = (
            weightedLikes
            + weightedReposts
            + weightedComments
        ) * timeDecay;

        /*
        // maybe try this?
        const engagementRate = (weightedLikes + weightedReposts + post.comments * commentsWeight) / post.viewCount;
        */
    
    }
    // maybe try this?
    if (timeSincePost < 300) { // first 5 minutes
        score += 5; // or another value
    }

    // get change in post score
    d_score = score - post.engagement_score;
    post.engagement_score = score;

    return d_score;
}

function calculateHashtagEngagementScore(hashtag, idx) {

    // don't handle post which has already been marked for removal
    if(hashtag.engagement_score < 0){
        return -1;
    }

    const MAX_HASHTAG_POSITION = 1000;
    const MAX_HASHTAG_AGE = 10;// 1 hours

    const timeDecayFactor = 0.9; // Adjust this factor based on how quickly you want scores to decay

    // calculate engagement score
    const timeSincePost = (Date.now() - new Date(hashtag.time_last_seen).getTime()) / 1000; // Time in seconds
    const timeDecay = Math.exp(-timeDecayFactor * timeSincePost / 3600); // Decay over hours

    let score = 0;
    let d_score = 0;

    // mark to remove all posts older than 1 hour and below tier position 1000
    if( timeSincePost > MAX_HASHTAG_AGE && idx > MAX_HASHTAG_POSITION ){
        
        // mark post for removal
        // should cause post to sink to bottom of tier list
        score = -1;

    }else{
        
        score = (
            hashtag.count
        ) * timeDecay;

    }

    // get change in post score
    d_score = score - hashtag.engagement_score;
    hashtag.engagement_score = score;

    return d_score;
}

const mongo_uri = `mongodb://${MONGO_ADDRESS}:27017?connectTimeoutMS=60000`;
//const mongo_client = new mongo.MongoClient(mongo_uri);

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
