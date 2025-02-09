import sys
import spacy
import pytextrank

# load a spaCy model, depending on language, scale, etc.
nlp = spacy.load("en_core_web_sm")
# add PyTextRank to the spaCy pipeline
nlp.add_pipe("textrank")


while True:
    
    # Read input from stdin
    text = sys.stdin.readline()

    keywords = nlp(text)
    # examine the top-ranked phrases in the document
    for phrase in keywords._.phrases[:10]:
        print(phrase.text)
    
    sys.stdout.flush()