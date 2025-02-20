let hashtags = ["#one", "#two", "#three #more #words #here", "#four https://www.com", "#five", "#Pendejo 💙#Swineocracy💙 #ElonMusk #gop"]

hashtags = hashtags.map(hashtag => {
    return hashtag.split(" ")[0];
})

console.log(hashtags);