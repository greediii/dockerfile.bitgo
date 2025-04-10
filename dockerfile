FROM bitgo/express:latest

ENV NODE_ENV=production
ENV BITGO_ENV=prod

EXPOSE 3080

CMD ["--port", "3080", "--bind", "0.0.0.0", "--disablessl", "--debug", "--disableenvcheck"]
