import sys
from keybert import KeyBERT

# Define the YAKE extractor
kw_model = KeyBERT()

while True:
    
    # Read input from stdin
    text = sys.stdin.readline()

    # Extract keywords with default parameters
    # You can customize parameters as needed (e.g., language, ngram size, etc.)
    keywords = kw_model.extract_keywords(text)

    # Print the extracted keywords
    for keyword, score in keywords:
        if(' ' in keyword):
            print(keyword.lower())
    
    sys.stdout.flush()