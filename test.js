let hashtags = ["#one", "#two", "#three #more #words #here", "#four https://www.com", "#five", "#Pendejo 💙#Swineocracy💙 #ElonMusk #gop",
    "#gntm Ad:"
]

hashtags = hashtags.map(hashtag => {
    return hashtag.split(" ")[0];
})

console.log(hashtags);