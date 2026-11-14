def serve():
    import uvicorn
    uvicorn.run('server:app', host='0.0.0.0', port=8000)
